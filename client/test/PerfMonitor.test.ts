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
