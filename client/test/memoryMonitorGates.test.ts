/**
 * `cache/MemoryMonitor.ts` — the three leak gates and the report they file.
 *
 * The module was 100% LINE / 78.8% branch: `test/render/textureByteAccounting.test.ts` and its
 * siblings drive `texBytes()` thoroughly, but nothing had ever constructed the `MemoryMonitor`
 * class itself. So `install()`, the sampling tick, all three over-budget triggers, the
 * still-climbing conditions, the re-warn cooldown and the whole `dump()` payload were reached
 * only as "the function ran once with the default inputs" — 24 uncovered branches, the largest
 * single cluster in the client.
 *
 * These branches are worth real cases rather than a percentage bump because this file is the
 * only thing that notices the leak class that has actually shipped twice (see the module header:
 * the un-destroyed-scene heap climb, and the 2026-08-25 three-RenderTextures-at-111 MB crash).
 * The failure mode when a gate is wrong is that it stays SILENT — the game keeps running and the
 * phone dies later with nothing in Loki — and the two "still climbing" conditions are exactly
 * the kind of guard whose inversion (fire when flat, stay quiet when growing) is invisible
 * without a test that holds the count still and then raises it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  baseTextureCache: {} as Record<string, { realWidth: number; realHeight: number }> | undefined,
  textureCache: {} as Record<string, unknown> | undefined,
  warns: [] as { msg: string; data: Record<string, unknown> }[],
  anomalies: [] as { type: string; msg: string; detail: Record<string, unknown> }[],
  anrProviders: [] as (() => unknown)[],
  pools: { rows: [] as { label: string; idle: number; estBytes: number }[], totalIdle: 0, totalBytes: 0 },
  bake: { count: 0, bytes: 0, largest: null as { key: string; w: number; h: number; bytes: number } | null },
  scene: null as string | null,
}));

vi.mock('pixi.js-legacy', () => ({
  utils: {
    get BaseTextureCache() { return h.baseTextureCache; },
    get TextureCache() { return h.textureCache; },
  },
  Container: class {},
  Ticker: class {},
}));

vi.mock('../src/net/log', () => ({
  netLog: () => ({
    debug: () => {},
    info: () => {},
    warn: (msg: string, data: Record<string, unknown>) => h.warns.push({ msg, data }),
    error: () => {},
  }),
}));

vi.mock('../src/net/anomaly', () => ({
  reportAnomaly: (type: string, msg: string, detail: Record<string, unknown>) =>
    h.anomalies.push({ type, msg, detail }),
  setAnrContextProvider: (p: () => unknown) => h.anrProviders.push(p),
  getActiveScene: () => h.scene,
}));

vi.mock('../src/cache/poolRegistry', () => ({ snapshotPools: () => h.pools }));
vi.mock('../src/render/bake', () => ({ bakeStats: () => h.bake }));

import { MemoryMonitor, texBytes } from '../src/cache/MemoryMonitor';

const MB = 1024 * 1024;

/** A ticker stand-in that lets a test fire exactly one sample worth of elapsed time. */
class FakeTicker {
  count = 7;
  deltaMS = 6_000; // > SAMPLE_EVERY_MS, so one fire() is one sample
  private cbs: (() => void)[] = [];
  add(cb: () => void): void { this.cbs.push(cb); }
  remove(cb: () => void): void { this.cbs = this.cbs.filter((c) => c !== cb); }
  fire(): void { for (const cb of [...this.cbs]) cb(); }
  /**
   * Invoke a listener that has already been removed. PIXI's Ticker walks its own linked list
   * during update(), so a listener removed mid-pass can still be called once — and by then the
   * monitor has dropped its `ticker` reference, which is the only way its `?? 16.7` /
   * `?? -1` fallbacks are reached.
   */
  fireDetached(): void { for (const cb of this.detached) cb(); }
  private detached: (() => void)[] = [];
  detach(): void { this.detached = [...this.cbs]; }
  get listeners(): number { return this.cbs.length; }
}

function install(opts: { stage?: unknown } = {}): { mon: MemoryMonitor; ticker: FakeTicker } {
  const mon = new MemoryMonitor();
  const ticker = new FakeTicker();
  mon.install(ticker as never, opts.stage as never);
  return { mon, ticker };
}

function put(key: string, realWidth: number, realHeight: number): void {
  (h.baseTextureCache as Record<string, { realWidth: number; realHeight: number }>)[key] = {
    realWidth,
    realHeight,
  };
}

/** N generated (no-slash key) textures of 1x1 — count without bytes. */
function putGenerated(n: number): void {
  for (let i = 0; i < n; i++) put(`pixiid_${i}`, 1, 1);
}

/** Install a localStorage whose getItem answers from `values` (or throws, if asked to). */
function stubStorage(values: Record<string, string>, opts: { throws?: boolean } = {}): void {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => {
      if (opts.throws) throw new Error('localStorage is unavailable in this context');
      return values[k] ?? null;
    },
  });
}

/**
 * Install a `performance` with an optional `memory` block and an optional `now`.
 *
 * `advanceMs` is how much the clock moves per `now()` call: 0 (the default) freezes it, which is
 * what keeps every follow-up sample inside the 30 s re-warn cooldown. A test that wants to prove
 * something about a LATER report has to move the clock past that cooldown, otherwise "no second
 * report" only proves the cooldown works — the assertion it actually wanted is invisible.
 */
function stubPerformance(opts: { usedMB?: number; withNow?: boolean; advanceMs?: number } = {}): void {
  const { usedMB, withNow = true, advanceMs = 0 } = opts;
  let t = 1_000_000;
  vi.stubGlobal('performance', {
    ...(withNow ? { now: () => (t += advanceMs) } : {}),
    ...(usedMB === undefined
      ? {}
      : {
          memory: {
            usedJSHeapSize: usedMB * MB,
            totalJSHeapSize: (usedMB + 50) * MB,
            jsHeapSizeLimit: 4096 * MB,
          },
        }),
  });
}

beforeEach(() => {
  h.baseTextureCache = {};
  h.textureCache = {};
  h.warns.length = 0;
  h.anomalies.length = 0;
  h.anrProviders.length = 0;
  h.pools = { rows: [], totalIdle: 0, totalBytes: 0 };
  h.bake = { count: 0, bytes: 0, largest: null };
  h.scene = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── The sampling cadence ────────────────────────────────────────────────────────────────────

describe('sampling', () => {
  it('does nothing until a whole sample interval of ticker time has accumulated', () => {
    stubPerformance({ usedMB: 5_000 }); // far over any threshold
    const { ticker } = install();
    ticker.deltaMS = 100; // 50 frames still short of the 5 s sample interval
    for (let i = 0; i < 40; i++) ticker.fire();
    expect(h.warns).toHaveLength(0);

    // Crossing the interval samples once and reports.
    ticker.deltaMS = 5_000;
    ticker.fire();
    expect(h.warns).toHaveLength(1);
  });

  it('uninstall removes the tick listener so a torn-down monitor stops sampling', () => {
    stubPerformance({ usedMB: 5_000 });
    const { mon, ticker } = install();
    expect(ticker.listeners).toBe(1);
    mon.uninstall();
    expect(ticker.listeners).toBe(0);
    ticker.fire();
    expect(h.warns).toHaveLength(0);
  });

  it('stays quiet when every gate is inside budget', () => {
    stubPerformance({ usedMB: 10 });
    put('assets/units/archer.png', 64, 64);
    const { ticker } = install();
    ticker.fire();
    expect(h.warns).toHaveLength(0);
    expect(h.anomalies).toHaveLength(0);
  });

  it('stays quiet on a platform with no performance.memory and nothing over budget', () => {
    // Safari / the WeChat runtime: heap sampling is simply unavailable, and that must not read as
    // "heap is 0, therefore fine to report" or as a crash — the other two gates carry the file.
    stubPerformance({});
    const { ticker } = install();
    ticker.fire();
    expect(h.warns).toHaveLength(0);
  });
});

// ── Gate ①: JS heap ─────────────────────────────────────────────────────────────────────────

describe('the JS heap gate', () => {
  it('fires at the threshold and names the actual usage', () => {
    stubPerformance({ usedMB: 400 }); // exactly DEFAULT_WARN_MB — `>=`, so it fires
    const { ticker } = install();
    ticker.fire();
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]!.msg).toContain('400MB');
    expect(h.warns[0]!.msg).toContain('warning threshold');
    expect(h.anomalies[0]!.type).toBe('mem');
  });

  it('does not fire one MB below the threshold', () => {
    stubPerformance({ usedMB: 399 });
    const { ticker } = install();
    ticker.fire();
    expect(h.warns).toHaveLength(0);
  });

  it('honours a tightened localStorage threshold', () => {
    // The documented per-platform override for low-end Android / WeChat.
    stubStorage({ nw_mem_warn_mb: '250' });
    stubPerformance({ usedMB: 300 });
    const { ticker } = install();
    ticker.fire();
    expect(h.warns[0]!.msg).toContain('250MB');
  });

  it('ignores a garbage or non-positive localStorage threshold and keeps the default', () => {
    for (const raw of ['not-a-number', '0', '-100', '']) {
      h.warns.length = 0;
      stubStorage({ nw_mem_warn_mb: raw });
      stubPerformance({ usedMB: 399 });
      const { ticker } = install();
      ticker.fire();
      expect(h.warns, `raw=${JSON.stringify(raw)} must fall back to the 400MB default`).toHaveLength(0);
    }
  });

  it('survives a localStorage that throws on read (private mode / a blocked WebView)', () => {
    stubStorage({}, { throws: true });
    stubPerformance({ usedMB: 500 });
    const { ticker } = install();
    expect(() => ticker.fire()).not.toThrow();
    expect(h.warns[0]!.msg).toContain('400MB');
  });
});

// ── Gate ②: generated-texture COUNT ─────────────────────────────────────────────────────────

describe('the generated-texture count gate', () => {
  it('fires only while the count is over budget AND still climbing', () => {
    stubStorage({ nw_gentex_budget: '3' });
    stubPerformance({ usedMB: 10 });
    const { ticker } = install();

    // Sample 1: 5 generated textures. Over budget, and the first sample counts as climbing
    // (lastSampledGenTex is -1), so it reports.
    putGenerated(5);
    ticker.fire();
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]!.msg).toContain('generated textures 5');
    expect(h.warns[0]!.msg).toContain('still climbing');

    // Sample 2: unchanged. Over budget but FLAT — a large-but-stable working set must stay quiet.
    // (The re-warn cooldown would also suppress it, so the next case proves the flat gate alone.)
    ticker.fire();
    expect(h.warns).toHaveLength(1);
  });

  it('a large but stable generated set never reports, however long it is sampled', () => {
    stubStorage({ nw_gentex_budget: '3' });
    stubPerformance({ usedMB: 10, advanceMs: 60_000 });
    putGenerated(50);
    const { ticker } = install();
    ticker.fire();          // first sample: climbing by definition, reports
    h.warns.length = 0;
    // Advance well past the 30 s re-warn cooldown with the count held still.
    ticker.deltaMS = 60_000;
    for (let i = 0; i < 5; i++) ticker.fire();
    expect(h.warns).toHaveLength(0);
  });

  it('URL-keyed asset textures never count toward the generated budget', () => {
    // The whole point of the split: the URL cache is bounded by dedup, generated textures are not.
    stubStorage({ nw_gentex_budget: '3' });
    stubPerformance({ usedMB: 10 });
    for (let i = 0; i < 50; i++) put(`assets/cards/card_${i}.png`, 16, 16);
    put('data:image/png;base64,AAA', 16, 16);
    put('blob:http://localhost/abc', 16, 16);
    const { ticker } = install();
    ticker.fire();
    expect(h.warns).toHaveLength(0);
  });
});

// ── Gate ③: decoded texture BYTES ───────────────────────────────────────────────────────────

describe('the decoded-bytes gate', () => {
  it('fires on few-but-enormous textures that the count gate cannot see', () => {
    // The 2026-08-25 shape, scaled down: a count of 3 against a budget of 600.
    stubPerformance({ usedMB: 10 });
    stubStorage({ nw_tex_budget_mb: '32' });
    put('pixiid_1', 3000, 1080);
    put('pixiid_2', 3000, 1080);
    put('pixiid_3', 3000, 1080);
    const { ticker } = install();
    ticker.fire();
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]!.msg).toContain('decoded textures');
    expect(h.warns[0]!.msg).toContain('largest');
    expect(h.warns[0]!.msg).toContain('3000x1080');
  });

  it('stays quiet when the byte total is over budget but flat', () => {
    stubPerformance({ usedMB: 10, advanceMs: 60_000 });
    stubStorage({ nw_tex_budget_mb: '1' });
    put('assets/bg/lobby.png', 2000, 2000);
    const { ticker } = install();
    ticker.fire();
    h.warns.length = 0;
    ticker.deltaMS = 60_000;
    for (let i = 0; i < 3; i++) ticker.fire();
    expect(h.warns).toHaveLength(0);
  });

  it('the heap gate wins the message when more than one gate is over budget at once', () => {
    stubPerformance({ usedMB: 900 });
    stubStorage({ nw_tex_budget_mb: '1', nw_gentex_budget: '1' });
    put('pixiid_1', 2000, 2000);
    put('pixiid_2', 2000, 2000);
    const { ticker } = install();
    ticker.fire();
    expect(h.warns[0]!.msg).toContain('JS heap');
  });
});

// ── The re-warn cooldown ────────────────────────────────────────────────────────────────────

describe('the re-warn cooldown', () => {
  it('coalesces repeated over-threshold samples inside the cooldown window', () => {
    // The sampling cadence is 5 s and the cooldown 30 s: without this, a leaking client would
    // file a report every 5 s for the rest of the session.
    stubPerformance({ usedMB: 900 });
    const { ticker } = install();
    for (let i = 0; i < 5; i++) ticker.fire();
    expect(h.warns).toHaveLength(1);
  });

  it('falls back to a monotonic 0 when performance.now is unavailable, which pins the first report only', () => {
    // With no `performance.now`, nowMs() is a constant 0: the first warning still gets through
    // (lastWarnMs starts at -Infinity) and every later one is inside the cooldown forever. That is
    // the intended degradation — one report beats none — and is worth pinning because it is what
    // a runtime without performance.now actually does.
    stubPerformance({ usedMB: 900, withNow: false });
    const { ticker } = install();
    ticker.deltaMS = 600_000;
    for (let i = 0; i < 4; i++) ticker.fire();
    expect(h.warns).toHaveLength(1);
  });
});

// ── The report payload ──────────────────────────────────────────────────────────────────────

describe('the dump payload', () => {
  it('carries heap / pools / gpu / texTop, and the generated-texture delta between reports', () => {
    stubPerformance({ usedMB: 900, advanceMs: 60_000 });
    h.pools = {
      rows: [{ label: 'unitSprite', idle: 12, estBytes: 12 * 2048 }],
      totalIdle: 12,
      totalBytes: 12 * 2048,
    };
    put('assets/cards/a.png', 64, 64);
    put('pixiid_1', 100, 100);
    const { ticker } = install();
    ticker.fire();

    const data = h.warns[0]!.data as Record<string, Record<string, unknown>>;
    expect(data.heap).toMatchObject({ usedMB: 900, limitMB: 4096 });
    expect(data.poolTotal).toMatchObject({ idle: 12 });
    expect(data.pools).toEqual([{ label: 'unitSprite', idle: 12, estKB: 24 }]);
    expect(data.gpu).toMatchObject({ generated: 1, genDelta: 0, baseTex: 2 });
    expect(data.texTop).toEqual(
      expect.arrayContaining([{ k: 'assets/cards', n: 1 }, { k: 'generated:', n: 1 }]),
    );

    // A second report (past the cooldown) carries the DELTA since the previous one — the number
    // that says "a leak is in progress" rather than just "the level is high".
    put('pixiid_2', 100, 100);
    put('pixiid_3', 100, 100);
    ticker.deltaMS = 60_000;
    ticker.fire();
    expect((h.warns[1]!.data.gpu as Record<string, unknown>).genDelta).toBe(2);
  });

  it('reports the heap as unavailable rather than as zeros when performance.memory is missing', () => {
    // Reached through the wx low-memory path, which is the case that actually has no heap reading.
    stubPerformance({});
    const wx = { onMemoryWarning: (cb: (res: { level?: number }) => void) => cb({ level: 10 }) };
    vi.stubGlobal('wx', wx);
    install();
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]!.msg).toContain('level 10');
    expect(h.warns[0]!.data.heap).toBe('unavailable');
  });

  it('names an unknown wx warning level rather than printing undefined', () => {
    stubPerformance({});
    vi.stubGlobal('wx', {
      onMemoryWarning: (cb: (res: { level?: number }) => void) => cb({}),
    });
    install();
    expect(h.warns[0]!.msg).toContain('level ?');
  });

  it('installs fine on a platform with no wx global at all', () => {
    stubPerformance({ usedMB: 10 });
    expect(() => install()).not.toThrow();
    expect(h.warns).toHaveLength(0);
  });

  it('reports nodes as -1 when installed without a stage, and walks the tree when given one', () => {
    stubPerformance({ usedMB: 900 });
    const withoutStage = install();
    withoutStage.ticker.fire();
    expect((h.warns[0]!.data.gpu as Record<string, unknown>).nodes).toBe(-1);

    h.warns.length = 0;
    const stage = { children: [{ children: [{ children: [] }, { children: [] }] }, { children: [] }] };
    const withStage = install({ stage });
    withStage.ticker.fire();
    // 1 stage + 2 direct children + 2 grandchildren.
    expect((h.warns[0]!.data.gpu as Record<string, unknown>).nodes).toBe(5);
  });

  it('caps the node walk and says so, rather than reporting a plausible-looking exact number', () => {
    // The walk is capped so that counting a leak does not make the stutter worse. The report has
    // to distinguish "exactly 200000 nodes" from "at least 200000" — the second is the one that
    // means the scene graph is unbounded, and a bare number reads as the first.
    //
    // The tree here shares one leaf object across every slot: countNodes counts pushes, so this
    // drives the cap with a single allocation instead of 200k of them. Not a shape PIXI would
    // produce, but exactly the arithmetic the cap guards.
    stubPerformance({ usedMB: 900 });
    const leaf = { children: [] as unknown[] };
    const stage = { children: new Array(200_001).fill(leaf) };
    const { ticker } = install({ stage });
    ticker.fire();
    expect((h.warns[0]!.data.gpu as Record<string, unknown>).nodes).toBe('200000+');
  });

  it('carries the bake cache stats, including the call site of the largest baked page', () => {
    stubPerformance({ usedMB: 900 });
    h.bake = {
      count: 2,
      bytes: 20 * MB,
      largest: { key: 'lobbybg:3000x1080@3', w: 3000, h: 1080, bytes: 12 * MB },
    };
    const { ticker } = install();
    ticker.fire();
    const gpu = (h.warns[0]!.data.gpu as Record<string, unknown>).bake as Record<string, unknown>;
    // The key is the difference between "a generated texture is huge" and "THIS call site is huge".
    expect(gpu).toMatchObject({ n: 2, MB: 20, top: 'lobbybg:3000x1080@3 3000x1080', topMB: 12 });
  });

  it('omits the bake `top` line when the bake cache is empty', () => {
    stubPerformance({ usedMB: 900 });
    const { ticker } = install();
    ticker.fire();
    const bake = (h.warns[0]!.data.gpu as Record<string, unknown>).bake as Record<string, unknown>;
    expect(bake).toEqual({ n: 0, MB: 0 });
    expect('top' in bake).toBe(false);
  });

  it('stamps the active scene on the anomaly when one is set, and omits it when not', () => {
    stubPerformance({ usedMB: 900 });
    const bare = install();
    bare.ticker.fire();
    expect('scene' in h.anomalies[0]!.detail).toBe(false);

    h.anomalies.length = 0;
    h.scene = 'LobbyScene';
    const stamped = install();
    stamped.ticker.fire();
    // The 2026-08-02 Loki triage could not tell which screen held 1487 nodes; this is that fix.
    expect(h.anomalies[0]!.detail.scene).toBe('LobbyScene');
  });
});


// ── A runtime where PIXI has no texture cache at all ────────────────────────────────────────

describe('with no PIXI base-texture cache', () => {
  it('reports -1 / omits the byte fields instead of throwing, and still files the heap warning', () => {
    // The provider and the sampler both run from app startup; a very early heap spike (or a
    // renderer that failed to initialise) can sample before either cache object exists.
    h.baseTextureCache = undefined;
    h.textureCache = undefined;
    stubPerformance({ usedMB: 900 });
    const { ticker } = install();
    expect(() => ticker.fire()).not.toThrow();

    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]!.msg).toContain('JS heap');
    const gpu = h.warns[0]!.data.gpu as Record<string, unknown>;
    expect(gpu).toMatchObject({ tex: -1, baseTex: -1, generated: -1 });
    // No cache means no byte accounting at all, rather than a misleading 0 MB.
    expect('texMB' in gpu).toBe(false);
    expect('largest' in gpu).toBe(false);
    expect(h.warns[0]!.data.texTop).toEqual([]);
  });

  it('a detached tick assumes a 16.7 ms frame and reports -1 tickers', () => {
    stubPerformance({ usedMB: 900 });
    const { mon, ticker } = install();
    ticker.detach();
    mon.uninstall();

    // 16.7 ms per detached tick: it takes 300 of them to reach the 5 s sample interval, which is
    // the fallback actually doing its job (a 0 would mean the sampler never fires again).
    for (let i = 0; i < 299; i++) ticker.fireDetached();
    expect(h.warns).toHaveLength(0);
    ticker.fireDetached();
    expect(h.warns).toHaveLength(1);
    expect((h.warns[0]!.data.gpu as Record<string, unknown>).tickers).toBe(-1);
  });
});

// ── The ANR context provider ────────────────────────────────────────────────────────────────

describe('the ANR context provider', () => {
  it('reports cheap GPU counters including texMB, and no scene-graph walk', () => {
    put('assets/cards/a.png', 64, 64);
    put('pixiid_1', 1000, 1000);
    h.textureCache = { a: 1, b: 2 };
    const { ticker } = install();
    const ctx = h.anrProviders[0]!() as { gpu: Record<string, unknown> };
    expect(ctx.gpu).toMatchObject({ tex: 2, baseTex: 2, tickers: ticker.count });
    expect(ctx.gpu.texMB).toBeCloseTo((64 * 64 + 1000 * 1000) * 4 / MB, 1);
    expect(ctx.gpu.largestMB).toBeCloseTo(1000 * 1000 * 4 / MB, 1);
    // Deliberately absent: the watchdog fires DURING a stall, so a 200k-node walk is excluded.
    expect('nodes' in ctx.gpu).toBe(false);
  });

  it('degrades to -1 counters and omits the byte fields when PIXI has no caches yet', () => {
    // Reachable in practice: the provider is installed at app startup and the watchdog can fire
    // before the renderer has created either cache.
    h.baseTextureCache = undefined;
    h.textureCache = undefined;
    install();
    const ctx = h.anrProviders[0]!() as { gpu: Record<string, unknown> };
    expect(ctx.gpu).toMatchObject({ tex: -1, baseTex: -1 });
    expect('texMB' in ctx.gpu).toBe(false);
    expect(texBytes()).toBeNull();
  });

  it('reports -1 tickers after uninstall instead of throwing', () => {
    const { mon } = install();
    mon.uninstall();
    const ctx = h.anrProviders[0]!() as { gpu: Record<string, unknown> };
    expect(ctx.gpu.tickers).toBe(-1);
  });
});

// ── texBytes / texTop edge shapes the byte-accounting suite does not cover ──────────────────

describe('cache scanning edges', () => {
  it('skips cache entries with no real size instead of counting them as 0-byte textures', () => {
    put('assets/ok.png', 10, 10);
    (h.baseTextureCache as Record<string, unknown>)['assets/pending.png'] = {};
    (h.baseTextureCache as Record<string, unknown>)['assets/zero.png'] = { realWidth: 0, realHeight: 5 };
    (h.baseTextureCache as Record<string, unknown>)['assets/zeroh.png'] = { realWidth: 5, realHeight: 0 };
    const s = texBytes()!;
    expect(s.totalMB).toBeCloseTo(10 * 10 * 4 / MB, 3);
    expect(s.largest).toBe('assets 10x10');
  });

  it('buckets data: and blob: sources by scheme rather than by path', () => {
    stubPerformance({ usedMB: 900 });
    put('data:image/png;base64,AAAA', 32, 32);
    put('blob:http://localhost:9090/1234', 32, 32);
    const { ticker } = install();
    ticker.fire();
    const texTop = h.warns[0]!.data.texTop as { k: string; n: number }[];
    expect(texTop.map((r) => r.k).sort()).toEqual(['blob:', 'data:']);
  });

  it('strips a query string before bucketing, so cache-busted URLs share one bucket', () => {
    put('assets/cards/a.png?v=2', 8, 8);
    put('assets/cards/b.png?v=3', 8, 8);
    const s = texBytes()!;
    expect(s.largest.startsWith('assets/cards ')).toBe(true);
  });
});
