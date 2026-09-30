// PerfMonitor: backgrounded/occluded-tab false-positive regression (2026-07-26, mirrors the
// 2026-07-15 ANR-watchdog "hidden sampled, not latched" fix in anomaly-chain.test.ts).
//
// The browser throttles rAF for hidden/occluded tabs to save power, which tanks the ticker's
// real fps with no actual JS slowness. PerfMonitor.onTick must discard any sampling window that
// was hidden at any point during it, exactly like installAnrWatchdog already does for ANR.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reportAnomaly = vi.fn();
// `takeFrameCost` is delegated to the REAL accumulator rather than stubbed: it is reset-on-read, so
// a stub that forgets to reset (or returns a fresh object every call) would hide exactly the leak
// this monitor must not have. Faking a contract is how a suite ends up verifying a protocol that does
// not exist — see the socialsvc `err()` envelope bug of 2026-09-12.
vi.mock('../src/net/anomaly', async () => {
  const real = await vi.importActual<typeof import('../src/net/anomaly/anrContext')>('../src/net/anomaly/anrContext');
  return { reportAnomaly, takeFrameCost: real.takeFrameCost };
});

const WINDOW_MS = 2_000;
const SUSTAIN_WINDOWS = 5;

class FakeTicker {
  deltaMS = 16.7;
  private cb: (() => void) | null = null;
  add(cb: () => void): void { this.cb = cb; }
  remove(_cb: unknown): void { this.cb = null; }
  /** Fire `n` frames each `deltaMs` apart (matches PIXI's ticker.add contract: onTick reads this.deltaMS itself). */
  tick(deltaMs: number, n = 1): void {
    this.deltaMS = deltaMs;
    for (let i = 0; i < n; i++) this.cb?.();
  }
}

function makeDoc() {
  const listeners = new Map<string, Array<() => void>>();
  const doc = {
    hidden: false,
    addEventListener: (type: string, cb: () => void) => {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
    removeEventListener: (type: string, cb: () => void) => {
      const arr = listeners.get(type) ?? [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  return { doc, fire: (type: string) => (listeners.get(type) ?? []).forEach((f) => f()) };
}

/** Feed one full ~10fps sampling window (20 frames @ 100ms = 2000ms accumulated, fps = 10). */
function feedLowFpsWindow(ticker: FakeTicker): void {
  ticker.tick(100, 20);
}

describe('PerfMonitor: hidden/occluded tab does not report a false low-fps stutter', () => {
  let doc: ReturnType<typeof makeDoc>['doc'];
  let fire: ReturnType<typeof makeDoc>['fire'];

  beforeEach(() => {
    vi.resetModules();
    reportAnomaly.mockClear();
    ({ doc, fire } = makeDoc());
    vi.stubGlobal('document', doc);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sustained low fps while the tab was hidden at any point during the window is not reported', async () => {
    const { PerfMonitor } = await import('../src/cache/PerfMonitor');
    const monitor = new PerfMonitor();
    const ticker = new FakeTicker();
    monitor.install(ticker as unknown as Parameters<typeof monitor.install>[0]);

    doc.hidden = true;
    fire('visibilitychange');
    doc.hidden = false;
    fire('visibilitychange'); // back to foreground before the window boundary is even reached

    for (let i = 0; i < SUSTAIN_WINDOWS; i++) feedLowFpsWindow(ticker);

    expect(reportAnomaly).not.toHaveBeenCalled();
  });

  it('a genuine sustained low fps while the tab stayed visible throughout still reports cpu', async () => {
    const { PerfMonitor } = await import('../src/cache/PerfMonitor');
    const monitor = new PerfMonitor();
    const ticker = new FakeTicker();
    monitor.install(ticker as unknown as Parameters<typeof monitor.install>[0]);

    for (let i = 0; i < SUSTAIN_WINDOWS; i++) feedLowFpsWindow(ticker);

    expect(reportAnomaly).toHaveBeenCalledTimes(1);
    const [type, msg, detail] = reportAnomaly.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(type).toBe('cpu');
    expect(msg).toContain('sustained low fps');
    expect(detail).toMatchObject({ fps: 10, thresholdFps: 25, sustainedMs: WINDOW_MS * SUSTAIN_WINDOWS });
  });
});

// The idle tick-rate throttle (renderPolicy's IDLE_FPS, 2026-09-09) drops the ticker to 20fps on a
// screen that is standing still. Those stretches paint nothing new, so since ADR-095 (2026-09-28) they
// are not part of the fps at all: only intervals that were full rate at both ends are counted. Before
// it, the watchdog clamped its threshold under the lowest cap in the window instead — which stopped
// the false alarms but still reported every idle menu as `fpsP50: 20`.
describe('PerfMonitor: idle-throttled stretches are not part of the fps', () => {
  let doc: ReturnType<typeof makeDoc>['doc'];

  beforeEach(() => {
    vi.resetModules();
    reportAnomaly.mockClear();
    ({ doc } = makeDoc());
    vi.stubGlobal('document', doc);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The policy's published counters; only `idle` matters here (renderPolicy sets it with the cap). */
  let stats: { ticks: number; painted: number; skipped: number; idle: boolean };

  async function monitor(): Promise<FakeTicker> {
    // Imported AFTER resetModules, so this is the same module instance PerfMonitor reads.
    const { setLiveFramePacing, setLiveRenderStats } = await import('../src/render/renderStats');
    stats = { ticks: 0, painted: 0, skipped: 0, idle: false };
    setLiveRenderStats(stats);
    setLiveFramePacing({ capFps: 60, refreshHz: 60 });
    const { PerfMonitor } = await import('../src/cache/PerfMonitor');
    const m = new PerfMonitor();
    const ticker = new FakeTicker();
    m.install(ticker as unknown as Parameters<typeof m.install>[0]);
    return ticker;
  }

  /** `windows` full sampling windows at `fps` (each 2000ms of accumulated deltaMS). */
  function feed(ticker: FakeTicker, fps: number, windows: number): void {
    const frameMs = 1000 / fps;
    for (let w = 0; w < windows; w++) ticker.tick(frameMs, 2000 / frameMs);
  }

  it('an idle screen at the 20fps cap is silence, not a cpu anomaly', async () => {
    const ticker = await monitor();
    stats.idle = true;
    feed(ticker, 20, SUSTAIN_WINDOWS + 2);
    expect(reportAnomaly).not.toHaveBeenCalled();
  });

  it('...even one that paints far below the idle cap: idle says nothing about paint speed', async () => {
    // The price of the new definition, pinned so it is a decision and not an accident: the old clamp
    // did report 10fps under a 20fps cap. A screen that is not changing cannot stutter visibly, and a
    // device that slow cannot hide it at full rate, where it is still caught (next cases).
    const ticker = await monitor();
    stats.idle = true;
    feed(ticker, 10, SUSTAIN_WINDOWS + 2);
    expect(reportAnomaly).not.toHaveBeenCalled();
  });

  it('20fps at full rate is still a stutter', async () => {
    const ticker = await monitor();
    feed(ticker, 20, SUSTAIN_WINDOWS);
    expect(reportAnomaly).toHaveBeenCalledWith('cpu', expect.stringContaining('sustained low fps'), expect.objectContaining({ fps: 20, thresholdFps: 25 }));
  });

  // The 2026-09-12 production case: a menu touched every few seconds spends most of each window
  // idle and ends it at full rate. Only the full-rate tail is measured, and it is 60.
  it('a window mostly idle with a full-rate tail is measured on the tail alone', async () => {
    const ticker = await monitor();
    for (let w = 0; w < SUSTAIN_WINDOWS + 2; w++) {
      stats.idle = true;
      ticker.tick(1000 / 20, 30);   // 1.5s idle
      stats.idle = false;
      ticker.tick(1000 / 60, 36);   // 0.6s at full rate (the first interval, the wake, is dropped)
    }
    expect(reportAnomaly).not.toHaveBeenCalled();
  });

  it('an idle window between slow full-rate ones neither breaks nor extends the streak', async () => {
    // A slow reactive menu that goes still between taps: the idle windows carry no evidence either
    // way. Resetting on them would let a genuinely slow device dodge the watchdog forever; counting
    // them would call a still screen slow.
    const ticker = await monitor();
    for (let w = 0; w < SUSTAIN_WINDOWS - 1; w++) {
      stats.idle = false;
      feed(ticker, 10, 1);
      stats.idle = true;
      feed(ticker, 20, 1);
    }
    expect(reportAnomaly).not.toHaveBeenCalled();
    stats.idle = false;
    feed(ticker, 10, 1);
    expect(reportAnomaly).toHaveBeenCalledTimes(1);
  });

  it('...and a device genuinely slow in that tail still reports', async () => {
    const ticker = await monitor();
    for (let w = 0; w < SUSTAIN_WINDOWS; w++) {
      stats.idle = true;
      ticker.tick(1000 / 20, 20);   // 1s idle
      stats.idle = false;
      ticker.tick(1000 / 10, 11);   // 1.1s at 10fps under a 60 cap
    }
    expect(reportAnomaly).toHaveBeenCalledWith('cpu', expect.stringContaining('sustained low fps'), expect.objectContaining({ fps: 10 }));
  });
});
