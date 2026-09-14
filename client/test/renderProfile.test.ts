// PerfMonitor's `render_profile` — the on-device frame-rate / paint-rate report (ADR-083 follow-up).
//
// Why it exists: ADR-083 shipped three throttles (dpr cap, maxFPS 60, demand-driven painting) whose
// only measurements were taken on one Windows desktop in a devtools session. The two hosts whose
// battery drain started the whole thing — iOS and WeChat — had no numbers at all, and no way to get
// them: WeChat cannot open a console, and its `nw_render_debug` counter was unreadable there anyway
// (see debugFlags.test.ts). PerfMonitor already samples fps in 2s windows for its stutter watchdog,
// so a healthy session now also reports that sample plus the render loop's paint counters.
//
// What these cases pin, in order of what would hurt most if it broke:
//   1. hidden windows never reach the report (a throttled background tab reads as a dying device);
//   2. the paint rate is a DIFF of the live counters, not a cumulative total (a cumulative number
//      would look like a paint storm on any session older than a minute);
//   3. the report is bounded per session (this is telemetry every client sends, not a debug build).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reportAnomaly = vi.fn();
const getActiveScene = vi.fn(() => 'WorldMapScene');
// The frame-cost accumulator is the REAL one, reached through a late-bound indirection rather than
// `vi.importActual`. Two reasons, and the second one cost a red run to find:
//   • it is reset-on-read, so a hand-written stub would make the "a discarded window must not leak
//     into the next one" case below unfalsifiable — it would assert against the stub's bookkeeping;
//   • `vi.importActual` hands back a SEPARATE module instance from the one a plain `await import()`
//     of the same path resolves to. PerfMonitor drained one copy while the test recorded into the
//     other, and all five cost assertions came back 0 — green-looking plumbing, zero signal.
let takeFrameCostImpl: () => unknown = () => ({ updMs: 0, updMaxMs: 0, rndMs: 0, rndMaxMs: 0 });
vi.mock('../src/net/anomaly', () => ({ reportAnomaly, getActiveScene, takeFrameCost: () => takeFrameCostImpl() }));

const track = vi.fn();
vi.mock('../src/analytics', () => ({ track }));

import type { RenderStats } from '../src/render/renderStats';

/** Mirrors the constants in src/cache/PerfMonitor.ts. */
const FIRST_PROFILE_WINDOWS = 15;
const PROFILE_EVERY_WINDOWS = 150;
const MAX_PROFILES_PER_SESSION = 6;

class FakeTicker {
  deltaMS = 16.7;
  maxFPS = 60;
  private cb: (() => void) | null = null;
  add(cb: () => void): void { this.cb = cb; }
  remove(_cb: unknown): void { this.cb = null; }
  tick(deltaMs: number, n = 1): void {
    this.deltaMS = deltaMs;
    for (let i = 0; i < n; i++) this.cb?.();
  }
}

function makeDoc() {
  const listeners = new Map<string, Array<() => void>>();
  const doc = {
    hidden: false,
    addEventListener: (t: string, cb: () => void) => { listeners.set(t, [...(listeners.get(t) ?? []), cb]); },
    removeEventListener: () => {},
  };
  return { doc, fire: (t: string) => (listeners.get(t) ?? []).forEach((f) => f()) };
}

/** The live accumulator instance PerfMonitor drains — re-imported per case (see beforeEach), and at
 *  module scope because `feedWindow` below records through it. */
let recordFrameSample: (ms: number) => void;
let recordRenderSample: (ms: number) => void;

/**
 * Feed `windows` complete sampling windows at `fps`.
 *
 * Only frame rates whose frame time divides the 2000ms window into a whole number of exactly
 * representable steps are allowed — 50 (20ms), 25 (40ms), 10 (100ms), 4 (250ms). At 60fps the frame
 * time is 16.666…ms: the count that reaches 2000ms overshoots or undershoots by a fraction, the
 * leftover frame carries into the next window, and after a dozen windows the boundary has drifted far
 * enough that a "25fps window" is reported as 33fps. That drift cost an hour once; the throw is here
 * so the next person gets a sentence instead of a mystery.
 */
function feedWindow(ticker: FakeTicker, fps: number, windows = 1, cost?: { upd?: number; rnd?: number }): void {
  const frameMs = 1000 / fps;
  const framesPerWindow = 2000 / frameMs;
  if (!Number.isInteger(framesPerWindow)) {
    throw new Error(`fps ${fps} does not divide the 2000ms window evenly — use 50 / 25 / 10 / 4`);
  }
  if (!cost) { for (let w = 0; w < windows; w++) ticker.tick(frameMs, framesPerWindow); return; }
  // Production tick order, and it matters by exactly one frame: SceneManager (NORMAL priority) times
  // `update` and records it, PerfMonitor's own listener (NORMAL, added later) may close the window
  // right there, and only then does RenderPolicy paint at LOW priority. So a window's last paint is
  // always accounted to the NEXT window. Mirroring it here keeps the boundary honest instead of
  // asserting against a tidier order than the one that ships.
  for (let w = 0; w < windows; w++) {
    for (let i = 0; i < framesPerWindow; i++) {
      if (cost.upd) recordFrameSample(cost.upd);
      ticker.tick(frameMs, 1);
      if (cost.rnd) recordRenderSample(cost.rnd);
    }
  }
}

const RENDER_INFO = { resolution: 2, dpr: 3, canvasW: 2778, canvasH: 1284 };

describe('render_profile', () => {
  let ticker: FakeTicker;
  let doc: ReturnType<typeof makeDoc>['doc'];
  let fire: ReturnType<typeof makeDoc>['fire'];
  let monitor: { install(t: unknown, i?: unknown): void; uninstall(): void };
  let stats: RenderStats;
  let setLiveRenderStats: (s: RenderStats | null) => void;

  beforeEach(async () => {
    vi.resetModules();
    track.mockClear();
    reportAnomaly.mockClear();
    ({ doc, fire } = makeDoc());
    vi.stubGlobal('document', doc);
    ticker = new FakeTicker();
    stats = { ticks: 0, painted: 0, skipped: 0 };
    // Imported AFTER resetModules, or PerfMonitor would read a different module instance of the
    // counter holder than the one this test writes to (and every paint field would come back absent).
    ({ setLiveRenderStats } = await import('../src/render/renderStats'));
    setLiveRenderStats(stats);
    // Same trap as the counter holder above, one module over: `vi.resetModules()` makes the mock
    // factory re-run, so the accumulator PerfMonitor drains is a NEW instance every case. Recording
    // through a module-scope import taken before this line would feed the previous case's copy, and
    // every cost field would come back 0 — a green test asserting nothing.
    const anr = await import('../src/net/anomaly/anrContext');
    ({ recordFrameSample, recordRenderSample } = anr);
    takeFrameCostImpl = anr.takeFrameCost;
    anr.takeFrameCost(); // drain anything the import chain itself recorded
    const { PerfMonitor } = await import('../src/cache/PerfMonitor');
    monitor = new PerfMonitor() as unknown as typeof monitor;
  });

  afterEach(() => {
    monitor.uninstall();
    setLiveRenderStats(null);
    vi.unstubAllGlobals();
  });

  /** Latch "this window was hidden" the way the browser does — a bare `doc.hidden = true` is not an
   *  event, and PerfMonitor deliberately latches on the event rather than sampling at window end. */
  function hide(): void { doc.hidden = true; fire('visibilitychange'); }
  function show(): void { doc.hidden = false; }

  /** Advance the render counters as a `live` scene would: every tick paints. */
  function paintEveryTick(ticks: number): void {
    stats.ticks += ticks;
    stats.painted += ticks;
  }

  it('reports nothing until enough visible windows have accumulated', () => {
    monitor.install(ticker, RENDER_INFO);
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS - 1);
    expect(track).not.toHaveBeenCalled();

    feedWindow(ticker, 50, 1);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]![0]).toBe('render_profile');
  });

  it('carries the fps spread, the active scene and the renderer facts it was installed with', () => {
    monitor.install(ticker, RENDER_INFO);
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS - 1);
    feedWindow(ticker, 25, 1); // one bad window drags the min down but not the median

    const props = track.mock.calls[0]![1] as Record<string, unknown>;
    expect(props.scene).toBe('WorldMapScene');
    expect(props.fpsP50).toBe(50);
    expect(props.fpsMin).toBe(25);
    expect(props.windows).toBe(FIRST_PROFILE_WINDOWS);
    expect(props.maxFps).toBe(60);
    expect(props.res).toBe(2);
    expect(props.dpr).toBe(3);
    // The one field that says whether ADR-083's dpr cap did anything on THIS device.
    expect(props.dprCapped).toBe(true);
    expect(props.canvasW).toBe(2778);
  });

  it('reports dprCapped false on a device the cap never bit (WeChat: dpr is always 1)', () => {
    monitor.install(ticker, { resolution: 1, dpr: 1, canvasW: 750, canvasH: 1334 });
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS);
    expect((track.mock.calls[0]![1] as Record<string, unknown>).dprCapped).toBe(false);
  });

  it('derives the paint rate from the counter DIFF, so a reactive scene reads below the tick rate', () => {
    // Pre-existing history the report must NOT count: 100k paints from earlier in the session.
    stats.ticks = 100_000; stats.painted = 100_000;
    monitor.install(ticker, RENDER_INFO);

    // 15 windows = 30s of wall time; the loop ticked 1800 times and painted only 360 (a reactive
    // menu sitting at ~12 paints/s).
    stats.ticks += 1800; stats.painted += 360;
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS);

    const props = track.mock.calls[0]![1] as Record<string, unknown>;
    expect(props.spanS).toBe(30);
    expect(props.tickPerSec).toBe(60);
    expect(props.paintPerSec).toBe(12);
    expect(props.skipPct).toBe(80);
  });

  it('the second report diffs against the first, not against boot', () => {
    monitor.install(ticker, RENDER_INFO);
    paintEveryTick(1800);
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS);
    expect(track).toHaveBeenCalledTimes(1);

    // A long stretch of a `live` battle: every tick paints.
    paintEveryTick(PROFILE_EVERY_WINDOWS * 120);
    feedWindow(ticker, 50, PROFILE_EVERY_WINDOWS);
    expect(track).toHaveBeenCalledTimes(2);
    const props = track.mock.calls[1]![1] as Record<string, unknown>;
    expect(props.paintPerSec).toBe(60);
    expect(props.skipPct).toBe(0);
  });

  it('discards windows the tab was hidden for — they neither count nor skew the fps', () => {
    monitor.install(ticker, RENDER_INFO);
    hide();
    feedWindow(ticker, 4, FIRST_PROFILE_WINDOWS); // a throttled background tab
    expect(track).not.toHaveBeenCalled();

    show();
    feedWindow(ticker, 4, 1);   // first visible window after unhide is still discarded (latched)
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS);
    expect(track).toHaveBeenCalledTimes(1);
    expect((track.mock.calls[0]![1] as Record<string, unknown>).fpsMin).toBe(50);
  });

  it('stops after the per-session cap (this ships to every client, not to a debug build)', () => {
    monitor.install(ticker, RENDER_INFO);
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS);
    for (let i = 1; i < MAX_PROFILES_PER_SESSION + 3; i++) feedWindow(ticker, 50, PROFILE_EVERY_WINDOWS);
    expect(track).toHaveBeenCalledTimes(MAX_PROFILES_PER_SESSION);
  });

  it('reports the paint rate even though app.ts installs this monitor BEFORE the render policy', () => {
    // The production boot order, which every other case in this file inverts: app.ts constructs
    // PerfMonitor (line ~97) and only later installs RenderPolicy (line ~143), and it is the policy
    // that publishes the counters. So at install() time there are none — and a baseline left null
    // silently drops the three paint fields from the FIRST report, the only one a session shorter
    // than ~5.5 minutes ever sends. That is what shipped: the single real `render_profile` in prod
    // carries fpsP50/dprCapped and no tickPerSec/paintPerSec/skipPct at all.
    setLiveRenderStats(null);
    monitor.install(ticker, RENDER_INFO);
    setLiveRenderStats(stats); // ← RenderPolicy.install(), a few milliseconds after the line above

    // Counters that GROW as the loop runs, not a bulk pre-load: a bulk add before the first tick
    // would land inside whatever baseline is taken and pass with the bug back in. 15 windows x 100
    // ticks at 20ms = 30s at 50 ticks/s, painting one tick in five = a reactive menu at 10 paints/s.
    for (let w = 0; w < FIRST_PROFILE_WINDOWS; w++) {
      for (let i = 0; i < 100; i++) {
        ticker.tick(20, 1);
        stats.ticks += 1;
        if (i % 5 === 0) stats.painted += 1;
      }
    }

    const props = track.mock.calls[0]![1] as Record<string, unknown>;
    expect(props.spanS).toBe(30);
    expect(props.tickPerSec).toBe(50);
    expect(props.paintPerSec).toBe(10);
    expect(props.skipPct).toBe(80);
  });

  it('still reports fps when no render policy is installed — just without the paint fields', () => {
    setLiveRenderStats(null);
    monitor.install(ticker, RENDER_INFO);
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS);
    const props = track.mock.calls[0]![1] as Record<string, unknown>;
    expect(props.fpsP50).toBe(50);
    expect(props.paintPerSec).toBeUndefined();
  });
  // ── where the frame budget went ─────────────────────────────────────────────────
  // `fpsP50` says a device is slow; `maxFps` vs `fpsMax` says whether it was even allowed to go
  // faster. Neither says WHERE the frame went, and that is the fork the 2026-09-11 dpr-2 session was
  // diagnosed across twice, wrongly, from mechanism alone.

  it('reports per-tick update and render cost alongside the frame rate', () => {
    monitor.install(ticker, RENDER_INFO);
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS, { upd: 3, rnd: 5 });

    const props = track.mock.calls[0]![1] as Record<string, unknown>;
    // 20ms frame period, 8ms of it in our JS: the shape that says the main thread is NOT the wall.
    expect(props.fpsP50).toBe(50);
    expect(props.updP50).toBe(3);
    expect(props.rndP50).toBe(5);
  });

  it('divides render cost by TICKS, not by paints — so it is already discounted by skipPct', () => {
    // A reactive scene painting every other tick pays 10ms per paint and 5ms per tick. The frame
    // budget is built from ticks (that is what the frame period measures), so the per-tick number is
    // the one that can be compared against 1000/fps. Reporting per-paint would make a scene look
    // twice as expensive precisely because demand-driven painting had made it cheaper.
    monitor.install(ticker, RENDER_INFO);
    for (let w = 0; w < FIRST_PROFILE_WINDOWS; w++) {
      for (let i = 0; i < 100; i++) {
        ticker.tick(20, 1);
        if (i % 2 === 0) recordRenderSample(10);
      }
    }
    const props = track.mock.calls[0]![1] as Record<string, unknown>;
    expect(props.rndP50).toBe(5);
    expect(props.rndMax).toBe(10); // the worst single call is still the real 10ms one
  });

  it('keeps the worst single call as a max, not as another average', () => {
    // One 40ms hitch inside a 3ms baseline. A p50 alone would report a perfectly healthy screen;
    // the pair (p50 low, max high) is what distinguishes "steadily expensive" from "mostly fine,
    // hitches" — two different bugs with two different fixes.
    monitor.install(ticker, RENDER_INFO);
    feedWindow(ticker, 50, 1, { upd: 3 });
    recordFrameSample(40);
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS - 1, { upd: 3 });

    const props = track.mock.calls[0]![1] as Record<string, unknown>;
    expect(props.updP50).toBe(3);
    expect(props.updMax).toBe(40);
  });

  it('drops the cost of a hidden window instead of letting it leak into the next one', () => {
    // The accumulator is reset-on-read, so the ONLY thing keeping a throttled background tab's
    // numbers out of the report is that PerfMonitor drains it before bailing on a hidden window.
    // Move that `takeFrameCost()` call below the bail and this case goes red — which is the point:
    // hidden windows are already discarded for fps, and a 50ms update from a throttled tab would
    // otherwise be the loudest number in the report.
    monitor.install(ticker, RENDER_INFO);
    hide();
    feedWindow(ticker, 50, 1, { upd: 50 });
    show();
    feedWindow(ticker, 50, 1, { upd: 3 });   // still discarded (latched), same as the fps case above
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS, { upd: 3 });

    const props = track.mock.calls[0]![1] as Record<string, unknown>;
    expect(props.updP50).toBe(3);
    expect(props.updMax).toBe(3);
  });

  it('starts the cost span over at each report', () => {
    // Same reason the paint counters are diffed rather than accumulated: a max carried across
    // reports would pin itself to the boot frame and every later report would repeat it forever.
    monitor.install(ticker, RENDER_INFO);
    feedWindow(ticker, 50, FIRST_PROFILE_WINDOWS, { upd: 3 });
    feedWindow(ticker, 50, PROFILE_EVERY_WINDOWS, { upd: 1 });

    expect(track).toHaveBeenCalledTimes(2);
    expect((track.mock.calls[0]![1] as Record<string, unknown>).updMax).toBe(3);
    expect((track.mock.calls[1]![1] as Record<string, unknown>).updMax).toBe(1);
  });
});
