/**
 * textureByteBudget.test.ts — MemoryMonitor's byte gate, the branch ADR-073 decision 3 added.
 *
 * `textureByteAccounting.test.ts` pins the arithmetic (`texBytes()`); this pins the part that
 * decides whether anyone ever hears about it: the "over budget AND still climbing" latch, the
 * localStorage override, and the fields the resulting `mem` report carries. None of that was covered
 * — a latch written by hand in one sitting, guarding the exact failure that got through last time.
 *
 * Drives the monitor through the ticker callback it registers, so the real onTick branch runs rather
 * than a reimplementation of it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { baseTextureCache, reports, bakeStub, anr } = vi.hoisted(() => ({
  baseTextureCache: {} as Record<string, { realWidth: number; realHeight: number }>,
  reports: [] as Array<{ type: string; msg: string; detail: Record<string, unknown> }>,
  bakeStub: { count: 0, bytes: 0, largest: null as null | { key: string; w: number; h: number; bytes: number } },
  /** Whatever MemoryMonitor handed to setAnrContextProvider, so a test can invoke it. */
  anr: { provider: null as null | (() => Record<string, unknown>) },
}));

vi.mock('pixi.js-legacy', () => ({
  utils: { BaseTextureCache: baseTextureCache, TextureCache: {} },
  RenderTexture: { create: () => ({ baseTexture: { realWidth: 0, realHeight: 0 } }) },
  Container: class { destroy(): void {} },
}));

vi.mock('../../src/net/log', () => ({
  netLog: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock('../../src/net/anomaly', () => ({
  reportAnomaly: (type: string, msg: string, detail: Record<string, unknown>) => { reports.push({ type, msg, detail }); },
  setAnrContextProvider: (p: () => Record<string, unknown>) => { anr.provider = p; },
  getActiveScene: () => 'LobbyScene',
}));

vi.mock('../../src/cache/poolRegistry', () => ({
  snapshotPools: () => ({ rows: [], totalIdle: 0, totalBytes: 0 }),
}));

vi.mock('../../src/render/bake', () => ({ bakeStats: () => bakeStub }));

import * as PIXI from 'pixi.js-legacy';
import { MemoryMonitor } from '../../src/cache/MemoryMonitor';

/**
 * Run `fn` in a runtime with NO `PIXI.utils.BaseTextureCache` at all — WeChat and any
 * non-standard PIXI build. `texBytes()` has an explicit `if (!c) return null` for it, and an empty
 * cache is a different thing from an absent one (0 MB vs "cannot say").
 */
function withoutTextureCache(fn: () => void): void {
  const utils = PIXI.utils as unknown as Record<string, unknown>;
  const saved = utils.BaseTextureCache;
  delete utils.BaseTextureCache;
  try { fn(); } finally { utils.BaseTextureCache = saved; }
}

const MB = 1024 * 1024;
/** SAMPLE_EVERY_MS is 5s; one tick of this crosses it. */
const TICK_MS = 6_000;

/** Fake ticker that hands back the registered onTick so tests can step it deliberately. */
function fakeTicker() {
  let cb: (() => void) | null = null;
  return {
    ticker: {
      add: (f: () => void) => { cb = f; },
      // Typed to take the listener so `uninstall()`'s call can be captured (see that test).
      remove: (_f: () => void) => {},
      count: 0,
      deltaMS: TICK_MS,
    },
    tick: (): void => { cb?.(); },
  };
}

/** Fill the cache with `mb` megabytes spread over one texture. */
function setCacheMB(mb: number): void {
  for (const k of Object.keys(baseTextureCache)) delete baseTextureCache[k];
  if (mb <= 0) return;
  const side = Math.round(Math.sqrt((mb * MB) / 4));
  baseTextureCache['pixiid_1'] = { realWidth: side, realHeight: side };
}

function install(stage?: unknown) {
  const { ticker, tick } = fakeTicker();
  const mon = new MemoryMonitor();
  mon.install(ticker as never, stage as never);
  return { mon, tick, ticker };
}

/** Fake `performance.memory` (Chromium-only in the field), or clear it. */
function setHeapMB(usedMB: number | null): void {
  Object.defineProperty(performance, 'memory', {
    configurable: true,
    value: usedMB == null ? undefined : {
      usedJSHeapSize: usedMB * MB, totalJSHeapSize: usedMB * 1.5 * MB, jsHeapSizeLimit: 2048 * MB,
    },
  });
}

/**
 * In-memory localStorage.
 *
 * Node's own `localStorage` global is inert here ("not available because --localstorage-file was not
 * provided"), so `setItem` is a silent no-op and an override test would pass for the wrong reason —
 * falling through to the default and matching it. Installing a real one is the only way these two
 * cases mean anything.
 */
function installStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => { map.clear(); },
    },
  });
}

beforeEach(() => {
  reports.length = 0;
  setCacheMB(0);
  bakeStub.count = 0;
  bakeStub.bytes = 0;
  bakeStub.largest = null;
  anr.provider = null;
  installStorage();
  setHeapMB(null);
  delete (globalThis as { wx?: unknown }).wx;
});

describe('decoded-texture byte budget', () => {
  it('stays quiet under budget', () => {
    setCacheMB(40);
    const { tick } = install();
    tick();
    expect(reports).toHaveLength(0);
  });

  it('fires once over the default 256 MB budget while climbing', () => {
    // The shape of the 2026-08-25 lobby: a third of a gigabyte in a handful of textures.
    setCacheMB(340);
    const { tick } = install();
    tick();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.type).toBe('mem');
    expect(reports[0]!.msg).toMatch(/decoded textures 340MB exceed budget of 256MB/);
  });

  // ── the "still climbing" latch ──────────────────────────────────────────────
  //
  // Isolating it needs care. The obvious test — fire once, then tick again with the same bytes and
  // assert silence — passes even with the latch deleted, because REWARN_EVERY_MS (30s) suppresses the
  // second report anyway. Mutation-checked and caught exactly that (M8): the test was green for the
  // wrong reason. Faking `performance.now()` past the cooldown would work; changing the BUDGET
  // between ticks is simpler and has no timer dependency at all. Tick 1 runs under a budget nothing
  // crosses, so it records `lastSampledTexMB` without ever reporting and leaves the rewarn gate
  // untouched; tick 2 lowers the budget so the ONLY thing deciding the outcome is the latch.

  it('stays quiet when a large working set is over budget but STABLE', () => {
    setCacheMB(340);
    globalThis.localStorage!.setItem('nw_tex_budget_mb', '1000');
    const { tick } = install();
    tick();                                                    // under budget: records 340, silent
    expect(reports).toHaveLength(0);
    globalThis.localStorage!.setItem('nw_tex_budget_mb', '256');
    tick();                                                    // over budget, but 340 -> 340
    expect(reports).toHaveLength(0);
  });

  it('stays quiet when bytes are FALLING, even from above the budget', () => {
    setCacheMB(400);
    globalThis.localStorage!.setItem('nw_tex_budget_mb', '1000');
    const { tick } = install();
    tick();
    globalThis.localStorage!.setItem('nw_tex_budget_mb', '256');
    setCacheMB(300);                                           // still over budget, shrinking
    tick();
    expect(reports).toHaveLength(0);
  });

  it('fires when bytes are still climbing past the budget', () => {
    // The positive half of the same setup — proves the two cases above are silent because of the
    // latch and not because this arrangement can never report at all.
    setCacheMB(300);
    globalThis.localStorage!.setItem('nw_tex_budget_mb', '1000');
    const { tick } = install();
    tick();
    globalThis.localStorage!.setItem('nw_tex_budget_mb', '256');
    setCacheMB(340);
    tick();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.msg).toMatch(/decoded textures 340MB exceed budget of 256MB/);
  });

  it('honours the nw_tex_budget_mb override', () => {
    // The knob exists so a low-end target can be tightened without a deploy.
    globalThis.localStorage?.setItem('nw_tex_budget_mb', '32');
    setCacheMB(60);
    const { tick } = install();
    tick();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.msg).toMatch(/exceed budget of 32MB/);
  });

  it('ignores a junk override rather than disabling the gate', () => {
    globalThis.localStorage?.setItem('nw_tex_budget_mb', 'not-a-number');
    setCacheMB(340);
    const { tick } = install();
    tick();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.msg).toMatch(/budget of 256MB/);
  });

  it('the report carries the byte fields, not just the counts', () => {
    // A `mem` line that says "3 generated textures" is what let the crash through. These are the
    // fields that make the next one readable at a glance.
    setCacheMB(340);
    bakeStub.count = 3;
    bakeStub.bytes = 334 * MB;
    bakeStub.largest = { key: 'lobbybg:3000x1080@3', w: 9000, h: 3240, bytes: 111 * MB };
    const { tick } = install();
    tick();
    const gpu = reports[0]!.detail.gpu as Record<string, unknown>;
    expect(gpu.texMB).toBeGreaterThan(300);
    expect(gpu.largest).toMatch(/pixiid_1 \d+x\d+/);
    expect(gpu.largestMB).toBeGreaterThan(300);
    // The bake cache's own line, and the cache KEY — "this call site is huge", not "some texture is".
    expect(gpu.bake).toMatchObject({ n: 3, top: 'lobbybg:3000x1080@3 9000x3240' });
    expect((gpu.bake as Record<string, number>).topMB).toBeCloseTo(111, 0);
    // The count axis is still reported alongside — the two gates guard different leak classes.
    expect(gpu).toHaveProperty('generated');
    expect(reports[0]!.detail.scene).toBe('LobbyScene');
  });

  it('is silent on an empty cache', () => {
    const { tick } = install();
    tick();
    expect(reports).toHaveLength(0);
  });

  it('is silent, and does not throw, in a runtime with no texture cache at all', () => {
    // Absent is not the same as empty: texBytes() returns null rather than 0 MB, and the gate must
    // treat "cannot say" as "do not report" instead of comparing undefined against the budget.
    withoutTextureCache(() => {
      const { tick } = install();
      expect(() => tick()).not.toThrow();
    });
    expect(reports).toHaveLength(0);
  });
});

// The rest of the monitor's reporting surface. Pulled in with the byte gate rather than left for
// later because the file-level coverage gate is per FILE: gating the new byte code means covering
// its neighbours, and every one of these is a live production reporting path that had no test.
describe('the reporting paths around the byte gate', () => {
  it('feeds texMB and largestMB into the ANR context', () => {
    // ADR-073 claims `anr` reports carry the byte counters — that claim had no test, and the
    // provider callback is registered at install() and only ever invoked by the ANR watchdog.
    setCacheMB(120);
    install();
    expect(anr.provider).toBeTypeOf('function');
    const gpu = anr.provider!().gpu as Record<string, unknown>;
    expect(gpu.texMB).toBeGreaterThan(100);
    expect(gpu).toHaveProperty('largestMB');
    // Cheap counters only in this path — no scene-graph walk (it fires *during* a stall).
    expect(gpu).not.toHaveProperty('nodes');
  });

  it('omits the byte fields from the ANR context when there is no texture cache to read', () => {
    withoutTextureCache(() => {
      install();
      const gpu = anr.provider!().gpu as Record<string, unknown>;
      expect(gpu).not.toHaveProperty('texMB');
      expect(gpu).toHaveProperty('baseTex');   // the count fields still report (as -1)
    });
  });

  it('reports on the JS-heap threshold, with the heap block filled in', () => {
    setHeapMB(500);              // over DEFAULT_WARN_MB (400)
    const { tick } = install();
    tick();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.msg).toMatch(/JS heap 500MB exceeds warning threshold of 400MB/);
    expect(reports[0]!.detail.heap).toMatchObject({ usedMB: 500, limitMB: 2048 });
  });

  it('says "unavailable" for the heap where performance.memory does not exist (Safari/WeChat)', () => {
    setCacheMB(340);             // fire via the byte gate instead
    const { tick } = install();
    tick();
    expect(reports[0]!.detail.heap).toBe('unavailable');
  });

  it('still reports the generated-texture COUNT gate — the two axes coexist', () => {
    // 700 tiny generated textures: over the count budget (600), nowhere near the byte budget. The
    // point of keeping both gates is that this case and the 340 MB case are different bugs.
    for (let i = 0; i < 700; i++) baseTextureCache[`pixiid_${i}`] = { realWidth: 8, realHeight: 8 };
    const { tick } = install();
    tick();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.msg).toMatch(/generated textures 700 exceed budget of 600/);
  });

  it('walks the stage for a node count when one was handed to install()', () => {
    const leaf = { children: [] as unknown[] };
    const stage = { children: [leaf, { children: [leaf] }] };
    setCacheMB(340);
    const { tick } = install(stage);
    tick();
    expect((reports[0]!.detail.gpu as Record<string, unknown>).nodes).toBe(4);
  });

  it('reports -1 nodes when installed without a stage', () => {
    setCacheMB(340);
    const { tick } = install();
    tick();
    expect((reports[0]!.detail.gpu as Record<string, unknown>).nodes).toBe(-1);
  });

  it('dumps on the WeChat OS low-memory signal, naming the level', () => {
    // The real budget gate on WeChat, where performance.memory does not exist at all.
    let cb: ((res: { level?: number }) => void) | null = null;
    (globalThis as { wx?: unknown }).wx = { onMemoryWarning: (f: (r: { level?: number }) => void) => { cb = f; } };
    setCacheMB(80);
    install();
    expect(cb).toBeTypeOf('function');
    cb!({ level: 15 });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.msg).toMatch(/wx onMemoryWarning.*15/);
    // No budget was crossed — a wx signal reports unconditionally, by design.
    expect((reports[0]!.detail.gpu as Record<string, unknown>).texMB).toBeGreaterThan(70);
  });

  it('uninstall() stops sampling', () => {
    setCacheMB(340);
    const { mon, tick, ticker } = install();
    const removed: unknown[] = [];
    ticker.remove = (f: () => void) => { removed.push(f); };
    mon.uninstall();
    expect(removed).toHaveLength(1);
    tick();   // the ticker is a fake, so this still calls through — the guard is the null ticker
    expect(reports).toHaveLength(0);
  });
});
