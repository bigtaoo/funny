// PerfMonitor: backgrounded/occluded-tab false-positive regression (2026-07-26, mirrors the
// 2026-07-15 ANR-watchdog "hidden sampled, not latched" fix in anomaly-chain.test.ts).
//
// The browser throttles rAF for hidden/occluded tabs to save power, which tanks the ticker's
// real fps with no actual JS slowness. PerfMonitor.onTick must discard any sampling window that
// was hidden at any point during it, exactly like installAnrWatchdog already does for ANR.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reportAnomaly = vi.fn();
vi.mock('../src/net/anomaly', () => ({ reportAnomaly }));

const WINDOW_MS = 2_000;
const SUSTAIN_WINDOWS = 5;

class FakeTicker {
  deltaMS = 16.7;
  /** 0 = uncapped, PIXI's own meaning. renderPolicy sets 60, or 20 once a screen sits still. */
  maxFPS = 0;
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
// screen that is standing still. The stutter watchdog's fixed 25fps threshold would then read every
// healthy idle menu as a dying device and file a cpu anomaly every 10 seconds — the same class of
// false positive as the hidden-tab one above, from the other direction: the device is not slow, it
// was asked to go slow. So the threshold is clamped under whatever ceiling the loop currently has.
describe('PerfMonitor: the idle frame-rate cap is not a stutter', () => {
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

  async function monitorOn(maxFPS: number): Promise<FakeTicker> {
    const { PerfMonitor } = await import('../src/cache/PerfMonitor');
    const monitor = new PerfMonitor();
    const ticker = new FakeTicker();
    ticker.maxFPS = maxFPS;
    monitor.install(ticker as unknown as Parameters<typeof monitor.install>[0]);
    return ticker;
  }

  /** `windows` full sampling windows at `fps` (each 2000ms of accumulated deltaMS). */
  function feed(ticker: FakeTicker, fps: number, windows: number): void {
    const frameMs = 1000 / fps;
    for (let w = 0; w < windows; w++) ticker.tick(frameMs, 2000 / frameMs);
  }

  it('20fps under a 20fps cap is silence, not a cpu anomaly', async () => {
    const ticker = await monitorOn(20);
    feed(ticker, 20, SUSTAIN_WINDOWS + 2);
    expect(reportAnomaly).not.toHaveBeenCalled();
  });

  it('...but a device genuinely failing to keep up with the idle cap still reports', async () => {
    // The point of clamping is to move the threshold, not to switch the watchdog off. 10fps under a
    // 20fps cap is half of what was asked for.
    const ticker = await monitorOn(20);
    feed(ticker, 10, SUSTAIN_WINDOWS);
    expect(reportAnomaly).toHaveBeenCalledWith('cpu', expect.stringContaining('sustained low fps'), expect.anything());
  });

  it('20fps under the normal 60fps cap is still a stutter (the clamp must not weaken that)', async () => {
    const ticker = await monitorOn(60);
    feed(ticker, 20, SUSTAIN_WINDOWS);
    expect(reportAnomaly).toHaveBeenCalledWith('cpu', expect.stringContaining('sustained low fps'), expect.anything());
  });
});
