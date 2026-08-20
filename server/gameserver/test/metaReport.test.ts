// MetaReporter unit tests. Previously zero coverage on this class; added alongside the new
// abandon() method (login-reconnect-prompt, 2026-07-28) — a fake global fetch stands in for meta,
// same technique as matchsvc/test/gatewayClient.test.ts.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { decompressReplayDoc } from '@nw/shared';
import { MetaReporter } from '../src/metaReport';
import type { MatchReport } from '../src/Room';

const BASE_REPORT: MatchReport = {
  roomId: 'R1',
  seed: 1,
  mode: 'friendly',
  reason: 'base',
  winnerSide: -1,
  hashOk: true,
  players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
  results: [],
  replay: {
    engineVersion: 0,
    mode: 'friendly',
    seed: 1,
    endFrame: 0,
    frames: [],
    meta: { recordedAt: 0, winner: -1 },
  },
};

describe('MetaReporter.abandon (login-reconnect-prompt shutdown cleanup, 2026-07-28)', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('no baseUrl configured → no-op, no fetch call', async () => {
    const reporter = new MetaReporter(null, 'key');
    await reporter.abandon(['a', 'b']);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('empty accountIds → no-op even with a configured baseUrl', async () => {
    const reporter = new MetaReporter('http://meta:8080', 'key');
    await reporter.abandon([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POSTs to /internal/match/abandon with the accountIds body + internal auth headers', async () => {
    const reporter = new MetaReporter('http://meta:8080', 'secret-key');
    await reporter.abandon(['a', 'b']);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://meta:8080/internal/match/abandon');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ accountIds: ['a', 'b'] });
    expect(init.headers['x-internal-key']).toBeTruthy();
    expect(init.headers['x-internal-caller']).toBe('gameserver');
  });

  it('fetch rejects (meta unreachable) → swallowed, does not throw (best-effort, TTL bounds the miss)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');
    await expect(reporter.abandon(['a'])).resolves.toBeUndefined();
  });

  it('res.body.cancel() rejecting on a successful abandon is swallowed too (nested try/catch)', async () => {
    global.fetch = vi.fn(async () => {
      const res = new Response('{}', { status: 200 });
      vi.spyOn(res.body!, 'cancel').mockRejectedValue(new Error('already closed'));
      return res;
    }) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');
    await expect(reporter.abandon(['a'])).resolves.toBeUndefined();
  });

  it('fetch resolves non-ok (e.g. 401) → swallowed, does not throw', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');
    await expect(reporter.abandon(['a'])).resolves.toBeUndefined();
  });
});

// report()/flush() had zero prior coverage either; a minimal smoke test alongside abandon()'s new
// harness so a future change to the shared `post()` helper (used by both) doesn't silently break one.
describe('MetaReporter.report (smoke — existing behavior, no prior test file)', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('no baseUrl configured → returns null without calling fetch', async () => {
    const reporter = new MetaReporter(null, 'key');
    const result = await reporter.report(BASE_REPORT);
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('successful POST to /internal/match/report returns elo (null when absent)', async () => {
    const reporter = new MetaReporter('http://meta:8080', 'key');
    const result = await reporter.report(BASE_REPORT);
    expect(result).toBeNull(); // friendly match report has no elo field
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://meta:8080/internal/match/report');
  });

  it('non-ok response (e.g. 500) -> report() returns null and enqueues for retry', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');
    const result = await reporter.report(BASE_REPORT);
    expect(result).toBeNull();
  });

  it('non-ok response whose body.cancel() also rejects -> still swallowed, returns null', async () => {
    global.fetch = vi.fn(async () => {
      const res = new Response('{}', { status: 500 });
      vi.spyOn(res.body!, 'cancel').mockRejectedValue(new Error('already closed'));
      return res;
    }) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');
    await expect(reporter.report(BASE_REPORT)).resolves.toBeNull();
  });

  it('fetch rejects (meta unreachable) -> report() returns null instead of throwing', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');
    await expect(reporter.report(BASE_REPORT)).resolves.toBeNull();
  });

  /**
   * The one place bytes become base64 in this codebase: `MatchReplay.frames[].cmds[].commands` is
   * `Uint8Array` (engine/transport side), `MatchReplayDoc`'s is `string` (storage side, because the
   * doc only ever exists as JSON inside a gzip blob — see shared/test/replayCodec.test.ts for why
   * bytes cannot survive that). Every previous fixture in this file used `frames: []`, so this
   * conversion — and therefore the whole reason the two types differ — was never executed by a test.
   */
  it('non-empty frames: engine command bytes are base64-encoded into replay_gz', async () => {
    const reporter = new MetaReporter('http://meta:8080', 'key');
    const bytes = Uint8Array.from([7, 0, 255, 42]);
    await reporter.report({
      ...BASE_REPORT,
      replay: {
        ...BASE_REPORT.replay,
        endFrame: 2,
        frames: [{ frame: 2, cmds: [{ side: 1, commands: bytes }] }],
      },
    });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sent = JSON.parse(String((init as RequestInit).body)) as { replay_gz: string };
    const doc = decompressReplayDoc(Buffer.from(sent.replay_gz, 'base64'));
    const commands = doc.frames[0]!.cmds[0]!.commands;
    expect(commands).toBe(Buffer.from(bytes).toString('base64'));
    // …and it is genuinely round-trippable back to the original bytes, not a lossy stringification.
    expect(Uint8Array.from(Buffer.from(commands, 'base64'))).toEqual(bytes);
  });

  it('ranked match with an elo payload -> report() returns it', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, elo: { 0: 12, 1: -12 } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');
    const result = await reporter.report({ ...BASE_REPORT, mode: 'ranked' });
    expect(result).toEqual({ 0: 12, 1: -12 });
  });
});

// flush()/drain() previously had zero coverage on the failure/retry path: a report() failure
// enqueues the body, drain() retries it in the background with exponential backoff, and flush()
// bounds how long shutdown waits for that background drain to finish.
describe('MetaReporter.flush / background drain (retry queue)', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('flush() with an empty queue resolves immediately without waiting', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');
    await expect(reporter.flush(10_000)).resolves.toBeUndefined();
  });

  it('a failed report() enqueues; drain() retries in the background and eventually delivers it', async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      return new Response(JSON.stringify({ ok: true }), { status: call === 1 ? 500 : 200 });
    }) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');

    await reporter.report(BASE_REPORT); // 1st call fails -> enqueued, drain() kicked off in the background
    expect(call).toBe(1);

    // drain()'s first retry waits 5s before re-posting.
    const flushed = reporter.flush(10_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushed;
    expect(call).toBe(2);
  });

  it('drain() retry that itself throws (not just non-ok) increments attempts and keeps retrying until it succeeds', async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      if (call === 1) return new Response('{}', { status: 500 }); // initial report() fails -> enqueued
      if (call === 2) throw new Error('ECONNRESET'); // first retry: the network call itself throws
      return new Response(JSON.stringify({ ok: true }), { status: 200 }); // second retry succeeds
    }) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');

    await reporter.report(BASE_REPORT);
    expect(call).toBe(1);

    const flushed = reporter.flush(30_000);
    await vi.advanceTimersByTimeAsync(5_000); // first retry (throws) — attempts++, still queued
    expect(call).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000); // second retry (attempts=1 -> 10s backoff) — succeeds
    await flushed;
    expect(call).toBe(3);
  });

  it('flush() times out with items still queued -> logs a warning, does not throw or hang', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch; // never succeeds
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reporter = new MetaReporter('http://meta:8080', 'key');

    await reporter.report(BASE_REPORT); // enqueued, background drain() will keep retrying forever
    const flushed = reporter.flush(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushed;

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreported match settlement'));
    warn.mockRestore();
  });
});
