/**
 * `net/anomaly/reporter.ts` — the anti-abuse gates and the "never let telemetry hurt the player"
 * arms.
 *
 * `anomaly-chain.test.ts` proves the whole client→Loki pipeline for a normal report. The 11
 * branches it does not reach are all failure/limit paths, and every one of them exists so a
 * broken reporting channel stays invisible to the person playing: a `localStorage` that throws,
 * a `detail` object that cannot be serialised, an unreachable transport, a report storm, a page
 * exit with nothing to send. The module is deliberately full of empty catch blocks — which is
 * precisely why they need cases, because "it silently did nothing" is both the intended
 * behaviour here and what a broken implementation looks like.
 *
 * Each case re-imports the module (`vi.resetModules`): the reporter is a module-level singleton
 * carrying the cooldown map, the session counter and the debounce timer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const BASE = 'https://api.test/api';

type Harness = {
  mod: typeof import('../src/net/anomaly/reporter');
  requests: { url: string; body: string }[];
};

/**
 * Fresh reporter module with `getApiBaseUrl` / `netTransport` mocked.
 * `base: null` models "no API base yet" (pre-bootstrap or a build with no server).
 * `transport: 'throw' | 'reject'` models an unreachable or synchronously-broken transport.
 */
async function fresh(opts: { base?: string | null; transport?: 'ok' | 'throw' | 'reject' } = {}): Promise<Harness> {
  const { base = BASE, transport = 'ok' } = opts;
  const requests: { url: string; body: string }[] = [];
  vi.resetModules();

  vi.doMock('../src/net/config', () => ({ getApiBaseUrl: () => base ?? '' }));
  vi.doMock('../src/net/transport', () => ({
    netTransport: () => {
      if (transport === 'throw') throw new Error('no transport in this environment');
      return {
        request: async (req: { url: string; body: string }) => {
          requests.push({ url: req.url, body: req.body });
          if (transport === 'reject') throw new Error('network down');
          return { ok: true, status: 200, text: '' };
        },
      };
    },
  }));
  vi.doMock('../src/net/log', () => ({
    netLog: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    recentClientLogs: () => [
      { level: 'warn', msg: 'something odd', ts: 1, tag: 'gw', seq: 1 },
      { level: 'error', msg: 'boom', ts: 2, seq: 2 },
    ],
  }));

  const mod = await import('../src/net/anomaly/reporter');
  return { mod, requests };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/net/config');
  vi.doUnmock('../src/net/transport');
  vi.doUnmock('../src/net/log');
});

/** Run the 1.5 s flush debounce to completion. */
async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_000);
}

// ── The envelope's environment probes ───────────────────────────────────────────────────────

describe('the upload envelope', () => {
  it('reports the build target as the platform, falling back to web for anything unknown', async () => {
    for (const [target, expected] of [
      ['wechat', 'wechat'],
      ['crazygames', 'crazygames'],
      ['mobile', 'web'],
      [undefined, 'web'],
    ] as const) {
      const { mod, requests } = await fresh();
      if (target === undefined) delete (globalThis as Record<string, unknown>).TARGET;
      else (globalThis as Record<string, unknown>).TARGET = target;
      mod.reportAnomaly('webgl_lost', 'ctx lost');
      await flushDebounce();
      expect(JSON.parse(requests[0]!.body).platform, String(target)).toBe(expected);
    }
    delete (globalThis as Record<string, unknown>).TARGET;
  });

  it('omits publicId when storage has none, and includes it when it does', async () => {
    const { mod, requests } = await fresh();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    mod.reportAnomaly('webgl_lost', 'a');
    await flushDebounce();
    expect('publicId' in JSON.parse(requests[0]!.body)).toBe(false);

    const withId = await fresh();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'nw_player_public_id' ? '123456789' : null),
      setItem: () => {}, removeItem: () => {},
    });
    withId.mod.reportAnomaly('webgl_lost', 'a');
    await flushDebounce();
    expect(JSON.parse(withId.requests[0]!.body).publicId).toBe('123456789');
  });

  it('still reports when localStorage throws on every access', async () => {
    // A private-mode / blocked-storage WebView. Telemetry must degrade to an anonymous report,
    // not throw out of the reporting call and take the caller's frame with it.
    const { mod, requests } = await fresh();
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(() => mod.reportAnomaly('webgl_lost', 'a')).not.toThrow();
    await flushDebounce();
    expect('publicId' in JSON.parse(requests[0]!.body)).toBe(false);

    // The default storage shim's write side must swallow it too.
    expect(() => mod.getStorage().setItem('k', 'v')).not.toThrow();
    expect(() => mod.getStorage().removeItem('k')).not.toThrow();
    expect(mod.getStorage().getItem('k')).toBeNull();
  });

  it('still reports when the INJECTED platform storage throws', async () => {
    // The shim above catches for the web path; an injected WeChat storage has its own behaviour,
    // so readPublicId needs its own guard — otherwise a throwing `wx.getStorageSync` turns every
    // anomaly report on that platform into an uncaught error inside whatever already failed.
    const { mod, requests } = await fresh();
    mod.setAnomalyStorage({
      getItem: () => { throw new Error('wx storage unavailable'); },
      setItem: () => {},
      removeItem: () => {},
    });
    expect(() => mod.reportAnomaly('webgl_lost', 'a')).not.toThrow();
    await flushDebounce();
    expect('publicId' in JSON.parse(requests[0]!.body)).toBe(false);
  });

  it('reports an unbaked build as 0.0.0 and a baked one verbatim', async () => {
    const { mod, requests } = await fresh();
    delete (globalThis as Record<string, unknown>).__NW_BUILD_VERSION__;
    expect(mod.readBuildVersion()).toBe('0.0.0');
    (globalThis as Record<string, unknown>).__NW_BUILD_VERSION__ = 'abc1234';
    mod.reportAnomaly('webgl_lost', 'a');
    await flushDebounce();
    expect(JSON.parse(requests[0]!.body).buildVersion).toBe('abc1234');
    delete (globalThis as Record<string, unknown>).__NW_BUILD_VERSION__;
  });

  it('injected platform storage replaces the globalThis shim', async () => {
    // The WeChat mini-game runtime has no global localStorage at all, so app.ts injects its own.
    const { mod, requests } = await fresh();
    mod.setAnomalyStorage({
      getItem: (k: string) => (k === 'nw_player_public_id' ? '999888777' : null),
      setItem: () => {},
      removeItem: () => {},
    });
    mod.reportAnomaly('webgl_lost', 'a');
    await flushDebounce();
    expect(JSON.parse(requests[0]!.body).publicId).toBe('999888777');
  });
});

// ── Truncation ──────────────────────────────────────────────────────────────────────────────

describe('truncation', () => {
  it('clip leaves a short string alone and marks a truncated one', async () => {
    const { mod } = await fresh();
    expect(mod.clip('abc', 5)).toBe('abc');
    expect(mod.clip('abcde', 5)).toBe('abcde'); // exactly at the limit is not truncated
    expect(mod.clip('abcdef', 5)).toBe('abcde…');
  });

  it('truncates an oversized message and detail rather than posting an unbounded body', async () => {
    const { mod, requests } = await fresh();
    mod.reportAnomaly('webgl_lost', 'x'.repeat(1_000), { pad: 'y'.repeat(5_000) });
    await flushDebounce();
    const ev = JSON.parse(requests[0]!.body).events[0];
    expect(ev.msg.length).toBe(mod.MSG_MAX + 1); // + the ellipsis
    expect(ev.detail.length).toBeLessThan(1_000);
    expect(ev.detail.endsWith('…')).toBe(true);
  });

  it('falls back to String() for a detail object JSON cannot serialise', async () => {
    // A circular reference (easy to produce by attaching a live object to a report) must not
    // make the reporting call throw inside whatever was already going wrong.
    const { mod, requests } = await fresh();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => mod.reportAnomaly('webgl_lost', 'circular', circular)).not.toThrow();
    await flushDebounce();
    expect(JSON.parse(requests[0]!.body).events[0].detail).toBe('[object Object]');
  });

  it('omits detail entirely when none is given', async () => {
    const { mod, requests } = await fresh();
    mod.reportAnomaly('webgl_lost', 'bare');
    await flushDebounce();
    expect('detail' in JSON.parse(requests[0]!.body).events[0]).toBe(false);
  });
});

// ── The two storm gates ─────────────────────────────────────────────────────────────────────

describe('cooldown and session cap', () => {
  it('coalesces a high-frequency type inside its cooldown and lets a different type through', async () => {
    const { mod, requests } = await fresh();
    mod.reportAnomaly('mem', 'first');
    mod.reportAnomaly('mem', 'second');   // inside the 60 s mem cooldown → dropped
    mod.reportAnomaly('cpu', 'other');    // a different type has its own cooldown
    await flushDebounce();
    const events = JSON.parse(requests[0]!.body).events as { msg: string }[];
    expect(events.map((e) => e.msg)).toEqual(['first', 'other']);
  });

  it('lets the same type through again once its cooldown has elapsed', async () => {
    const { mod, requests } = await fresh();
    mod.reportAnomaly('anr', 'stall 1');
    await flushDebounce();
    vi.setSystemTime(Date.now() + 31_000); // anr cooldown is 30 s
    mod.reportAnomaly('anr', 'stall 2');
    await flushDebounce();
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1]!.body).events[0].msg).toBe('stall 2');
  });

  it('reports rare types with no cooldown at all', async () => {
    const { mod, requests } = await fresh();
    mod.reportAnomaly('webgl_lost', 'lost 1');
    mod.reportAnomaly('webgl_lost', 'lost 2');
    await flushDebounce();
    expect(JSON.parse(requests[0]!.body).events).toHaveLength(2);
  });

  it('stops reporting once the per-session cap is reached, counting sent and queued together', async () => {
    // The cap is the last line of defence against a client that has gone into a failure loop
    // filing 50 reports a second for the rest of the session.
    const { mod, requests } = await fresh();
    for (let i = 0; i < 60; i++) mod.reportAnomaly('webgl_lost', `lost ${i}`);
    await flushDebounce();
    expect(JSON.parse(requests[0]!.body).events).toHaveLength(50);

    // ...and the cap still holds after the queue has drained (`sent` keeps counting).
    mod.reportAnomaly('webgl_lost', 'one more');
    await flushDebounce();
    expect(requests).toHaveLength(1);
  });

  it('debounces a burst into one request instead of one per event', async () => {
    const { mod, requests } = await fresh();
    mod.reportAnomaly('webgl_lost', 'a');
    await vi.advanceTimersByTimeAsync(500);
    mod.reportAnomaly('webgl_lost', 'b'); // the timer is already armed — must not arm a second
    await flushDebounce();
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.body).events).toHaveLength(2);
  });
});

// ── Delivery failures ───────────────────────────────────────────────────────────────────────

describe('delivery', () => {
  it('sends nothing while there is no API base, and does not lose the queue', async () => {
    // Pre-bootstrap reports (a crash sentinel firing at startup) stay queued for the exit beacon
    // rather than being dropped or posted to a relative URL.
    const { mod, requests } = await fresh({ base: null });
    mod.reportAnomaly('crash', 'previous session died');
    await flushDebounce();
    expect(requests).toHaveLength(0);
    mod.anomalyReporter.flushBeacon();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(0); // still no base to send to
  });

  it('swallows a rejected upload and does not re-queue it', async () => {
    // Deliberate: re-queueing would let an offline client accumulate an unbounded backlog and
    // then dump it all at once.
    const { mod, requests } = await fresh({ transport: 'reject' });
    mod.reportAnomaly('webgl_lost', 'a');
    await flushDebounce();
    expect(requests).toHaveLength(1);

    mod.reportAnomaly('webgl_lost', 'b');
    await flushDebounce();
    const second = JSON.parse(requests[1]!.body).events as { msg: string }[];
    expect(second.map((e) => e.msg)).toEqual(['b']); // 'a' was not retried
  });

  it('swallows a transport that cannot even be constructed, on both send paths', async () => {
    const { mod } = await fresh({ transport: 'throw' });
    mod.reportAnomaly('webgl_lost', 'a');
    // The exit beacon runs BEFORE the debounce here, so the queue is still full when the
    // synchronous throw happens — the outer catch is the only thing between it and a page-unload
    // handler that dies with an uncaught error.
    expect(() => mod.anomalyReporter.flushBeacon()).not.toThrow();
    await expect(flushDebounce()).resolves.toBeUndefined();
  });
});

// ── The exit beacon ─────────────────────────────────────────────────────────────────────────

describe('the exit beacon', () => {
  it('sends nothing on a clean exit with an empty queue', async () => {
    const { mod, requests } = await fresh();
    mod.anomalyReporter.flushBeacon();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(0);
  });

  it('attaches recent log breadcrumbs to a pending queue, tagging each with its level', async () => {
    // The breadcrumbs are the only context a hard-exit report carries, and they are attached at
    // beacon time rather than at report time — a clean exit must not upload the log ring.
    const { mod, requests } = await fresh();
    mod.reportAnomaly('anr', 'frozen');
    mod.anomalyReporter.flushBeacon();
    await vi.advanceTimersByTimeAsync(0);

    const events = JSON.parse(requests[0]!.body).events as { type: string; msg: string }[];
    expect(events[0]!.msg).toBe('frozen');
    // A crumb with a tag renders it; one without omits the separator rather than printing
    // `[crumb:error:undefined]`.
    expect(events[1]!.msg).toBe('[crumb:warn:gw] something odd');
    expect(events[2]!.msg).toBe('[crumb:error] boom');
    expect(events.slice(1).every((e) => e.type === 'crash')).toBe(true);
  });

  it('posts uncredentialed, which is the whole reason it is not sendBeacon', async () => {
    const { mod } = await fresh();
    let captured: Record<string, unknown> | null = null;
    vi.resetModules();
    vi.doMock('../src/net/config', () => ({ getApiBaseUrl: () => BASE }));
    vi.doMock('../src/net/transport', () => ({
      netTransport: () => ({ request: async (r: Record<string, unknown>) => { captured = r; return { ok: true }; } }),
    }));
    vi.doMock('../src/net/log', () => ({
      netLog: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
      recentClientLogs: () => [],
    }));
    const reloaded = await import('../src/net/anomaly/reporter');
    reloaded.reportAnomaly('crash', 'died');
    reloaded.anomalyReporter.flushBeacon();
    await vi.advanceTimersByTimeAsync(0);
    expect(captured).toMatchObject({ credentials: 'omit', keepalive: true, method: 'POST' });
    expect(mod).toBeDefined();
  });
});
