/**
 * framePacer.ts — the frame-rate cap, implemented as a whole-number divisor of the display's
 * refresh rate, and one rAF loop that drives both PIXI tickers on the same beat (ADR-094).
 *
 * Why not `ticker.maxFPS`, which is what ADR-083/086 used: PIXI's throttle is
 *
 *     const delta = currentTime - this._lastFrame | 0;
 *     if (delta < this._minElapsedMS) return;
 *
 * — the elapsed time is TRUNCATED to whole milliseconds before it is compared with `1000 / maxFPS`.
 * On a 60 Hz display a frame 16.67 ms after the last one reads as 16, which is less than 16.67, so
 * the frame is dropped. Measured 2026-09-28 in real headed Chrome across 53 screens: every screen lost
 * ~4 frames per 3 s to this, each one a 33 ms hole in an otherwise perfectly even rAF stream (and
 * the reason production `render_profile` reads `fpsP50: 59`, never 60). Any millisecond-comparison
 * throttle has the same shape of problem on 75 / 90 / 144 Hz panels: the cap does not divide the
 * refresh rate, so the cadence alternates between 1 and 2 (or 2 and 3) vsyncs.
 *
 * And `PIXI.Ticker.shared` — boil lines, 14 battle / card fx callbacks — ran its own rAF loop with its
 * own throttle, so at the 20 fps idle cap every one of its ticks landed on a different vsync from the
 * paint it was animating for.
 *
 * So: both tickers stop running themselves; one loop here counts vsyncs and runs both every N-th,
 * `N ≈ round(refreshHz / cap)` (see {@link vsyncDivisor}). The cadence is always even. The price is
 * that the achieved rate is refreshHz / N rather than exactly the cap (144 Hz → 72, 90 Hz → 90);
 * rounding rather than `ceil` because an even 75 on a 75 Hz panel is what "stable" means, and 37.5
 * is not.
 */
import type * as PIXI from 'pixi.js-legacy';

/** The subset of `PIXI.Ticker` the pacer drives. */
export type PacedTicker = Pick<PIXI.Ticker, 'update' | 'stop' | 'start' | 'started' | 'autoStart' | 'maxFPS'>;

export interface FrameScheduler {
  request(cb: (t: number) => void): number;
  cancel(id: number): void;
}

/**
 * Rounding boundary offset for {@link vsyncDivisor}: the divisor flips at a ratio of x.6, not x.5.
 *
 * A boundary exactly at x.5 sits ON a common panel: 90 Hz / cap 60 = 1.5, 30 Hz / cap 20 = 1.5. There
 * the refresh estimate wobbling by a hundredth of a Hz would flip the divisor between two values from
 * one frame to the next — an uneven cadence, the one thing this module exists to prevent. At x.6 no
 * common rate (60/75/90/100/120/144/165/240 against caps 60 and 20) is within 0.05 of a boundary.
 */
const DIVISOR_BIAS = 0.1;

/** How many vsyncs apart two runs are, for a refresh rate and a cap (0 = uncapped). */
export function vsyncDivisor(refreshHz: number, capFps: number): number {
  if (!(capFps > 0) || !(refreshHz > 0)) return 1;
  return Math.max(1, Math.round(refreshHz / capFps - DIVISOR_BIAS));
}

/** rAF intervals the refresh estimate is the median of. Enough that a dropped frame or two cannot move it. */
const PERIOD_SAMPLES = 16;
/** Intervals longer than this are a stall or a backgrounded tab, not a refresh period. */
const MAX_PERIOD_MS = 250;
/** Assumed until the first samples arrive. */
const DEFAULT_PERIOD_MS = 1000 / 60;

/** Display refresh period, as the median of the last {@link PERIOD_SAMPLES} rAF intervals. */
export class VsyncPeriodEstimator {
  private readonly ring = new Float64Array(PERIOD_SAMPLES);
  private readonly scratch = new Float64Array(PERIOD_SAMPLES);
  private count = 0;
  private next = 0;
  periodMs = DEFAULT_PERIOD_MS;

  push(intervalMs: number): void {
    if (!(intervalMs > 0) || intervalMs > MAX_PERIOD_MS) return;
    this.ring[this.next] = intervalMs;
    this.next = (this.next + 1) % PERIOD_SAMPLES;
    if (this.count < PERIOD_SAMPLES) this.count++;
    const s = this.scratch.subarray(0, this.count);
    s.set(this.ring.subarray(0, this.count));
    s.sort();
    this.periodMs = s[this.count >> 1];
  }

  get refreshHz(): number { return 1000 / this.periodMs; }
}

function browserScheduler(): FrameScheduler {
  return {
    request: (cb) => requestAnimationFrame(cb),
    cancel: (id) => cancelAnimationFrame(id),
  };
}

interface Saved { autoStart: boolean; started: boolean; maxFPS: number }

export class FramePacer {
  private readonly estimator = new VsyncPeriodEstimator();
  private saved: Saved[] = [];
  private rafId: number | null = null;
  private lastFrameMs = -1;
  /** Vsyncs elapsed since the last run. Starts saturated so the first frame always runs. */
  private sinceRun = Number.POSITIVE_INFINITY;
  /** Current cap in fps; 0 = uncapped. */
  capFps = 0;
  /** Runs since install — the counter tests and the measurement recipe read. */
  runs = 0;

  constructor(
    /** Driven in this order on every run: animation first, the painting ticker last. */
    private readonly tickers: readonly PacedTicker[],
    private readonly scheduler: FrameScheduler = browserScheduler(),
  ) {}

  get refreshHz(): number { return this.estimator.refreshHz; }

  install(): void {
    this.saved = this.tickers.map((t) => ({ autoStart: t.autoStart, started: t.started, maxFPS: t.maxFPS }));
    for (const t of this.tickers) {
      // autoStart off first: with it on, the next `add()` on a stopped ticker restarts its own loop
      // (`Ticker._startIfPossible`), and `Ticker.shared` is created with autoStart = true.
      t.autoStart = false;
      t.stop();
      t.maxFPS = 0;
    }
    this.rafId = this.scheduler.request(this.onFrame);
  }

  uninstall(): void {
    if (this.rafId !== null) this.scheduler.cancel(this.rafId);
    this.rafId = null;
    this.tickers.forEach((t, i) => {
      const s = this.saved[i];
      if (!s) return;
      t.maxFPS = s.maxFPS;
      t.autoStart = s.autoStart;
      if (s.started) t.start();
    });
    this.saved = [];
  }

  /** One rAF callback. Public so tests can feed timestamps by hand. */
  onFrame = (t: number): void => {
    // Re-arm before running anything: PIXI's own loop re-requested AFTER `update`, so one throwing
    // listener stopped the whole client. Here it costs that one frame.
    this.rafId = this.scheduler.request(this.onFrame);
    if (this.lastFrameMs >= 0) {
      const dt = t - this.lastFrameMs;
      this.estimator.push(dt);
      // Count the vsyncs that actually went by: after a long frame, run now rather than waiting a
      // further N on top of the stall.
      this.sinceRun += Math.max(1, Math.round(dt / this.estimator.periodMs));
    }
    this.lastFrameMs = t;
    if (this.sinceRun < vsyncDivisor(this.estimator.refreshHz, this.capFps)) return;
    this.sinceRun = 0;
    this.runs++;
    for (const ticker of this.tickers) ticker.update(t);
  };
}
