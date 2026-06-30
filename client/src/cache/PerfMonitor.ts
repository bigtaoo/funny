import * as PIXI from 'pixi.js-legacy';
import { netLog } from '../net/log';
import { reportAnomaly } from '../net/anomaly';

// Runtime CPU / main-thread saturation monitor: browsers expose no direct CPU usage API; the observable equivalent signal is "main thread fully occupied".
// Two parallel sampling paths; if either sustains a threshold breach, one cpu anomaly is reported (reportAnomaly → full-volume channel → Loki):
//
//   ① Long-task busy ratio (Chromium only / where PerformanceObserver('longtask') is supported): sum of all >50ms
//      main-thread long-task durations within the window ÷ window length. A high ratio means the main thread is saturated by JS = perceived "CPU spike / stutter".
//   ② Sustained low FPS (available everywhere, including WeChat): estimates per-window FPS from ticker.deltaMS; sustained low FPS across multiple consecutive windows triggers a stutter report.
//      Environments that don't support longtask (WeChat) fall back to this path.
//
// Structurally mirrors MemoryMonitor: attached to app.ticker, persists across scenes, cooldown prevents alert flooding (reportAnomaly already applies a 60s cooldown for cpu-class events).
// Thresholds can be overridden via localStorage 'nw_fps_warn' (FPS below this value is considered a stutter) / 'nw_cpu_busy_warn' (long-task busy ratio 0~1).

const log = netLog('perf');

const DEFAULT_FPS_WARN = 25;        // sustained FPS below this is considered a stutter (5fps headroom to avoid false positives on 30Hz locked devices)
const DEFAULT_BUSY_WARN = 0.5;      // long-task busy ratio ≥ this value is considered main-thread saturation
const WINDOW_MS = 2_000;            // sampling window
const SUSTAIN_WINDOWS = 5;          // report only after this many consecutive low-FPS windows (≈10s), to avoid reporting transient spikes

function numFromLs(key: string, fallback: number): number {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const v = raw == null ? NaN : Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* localStorage unavailable: use default */ }
  return fallback;
}

interface LongTaskEntry { duration: number }
interface PerfObserver { observe(opts: { entryTypes: string[] }): void; disconnect(): void }

/** Application-wide singleton CPU / main-thread saturation monitor. Installed once via install(app.ticker) in app.ts; persists across scenes. */
export class PerfMonitor {
  private ticker: PIXI.Ticker | null = null;
  private accMs = 0;
  private frames = 0;
  private lowFpsStreak = 0;
  /** Cumulative long-task duration (ms) within the current sampling window; accumulated in the PerformanceObserver callback and reset at window end. */
  private longTaskMs = 0;
  private observer: PerfObserver | null = null;

  install(ticker: PIXI.Ticker): void {
    this.ticker = ticker;
    ticker.add(this.onTick);
    this.installLongTaskObserver();
  }

  uninstall(): void {
    this.ticker?.remove(this.onTick);
    this.ticker = null;
    try { this.observer?.disconnect(); } catch { /* ignore */ }
    this.observer = null;
  }

  private installLongTaskObserver(): void {
    const Ctor = (globalThis as { PerformanceObserver?: new (cb: (list: { getEntries(): LongTaskEntry[] }) => void) => PerfObserver }).PerformanceObserver;
    if (!Ctor) return; // not supported (WeChat etc.): fall back to FPS path only
    try {
      this.observer = new Ctor((list) => {
        for (const e of list.getEntries()) this.longTaskMs += e.duration;
      });
      this.observer.observe({ entryTypes: ['longtask'] });
    } catch { this.observer = null; } // some environments construct successfully but throw on observe('longtask'): degrade to FPS path
  }

  private onTick = (): void => {
    this.frames += 1;
    this.accMs += this.ticker?.deltaMS ?? 16.7;
    if (this.accMs < WINDOW_MS) return;

    const windowMs = this.accMs;
    const fps = (this.frames * 1000) / windowMs;
    const busyRatio = Math.min(1, this.longTaskMs / windowMs);
    this.accMs = 0;
    this.frames = 0;
    this.longTaskMs = 0;

    // ① Long-task busy ratio: report immediately if the threshold is breached in a single window (a long task is hard evidence of a saturated main thread).
    if (this.observer && busyRatio >= numFromLs('nw_cpu_busy_warn', DEFAULT_BUSY_WARN)) {
      reportAnomaly('cpu', `main-thread busy ${(busyRatio * 100).toFixed(0)}% over ${Math.round(windowMs)}ms`, {
        busyRatio: Math.round(busyRatio * 100) / 100, windowMs: Math.round(windowMs), fps: Math.round(fps),
      });
      log.warn(`main-thread busy ${(busyRatio * 100).toFixed(0)}%`, { fps: Math.round(fps) });
      return; // already reported; do not also trigger the FPS path for this window
    }

    // ② Sustained low FPS: report only after multiple consecutive windows (transient drops or scene transitions do not count).
    const fpsWarn = numFromLs('nw_fps_warn', DEFAULT_FPS_WARN);
    if (fps < fpsWarn) {
      this.lowFpsStreak += 1;
      if (this.lowFpsStreak >= SUSTAIN_WINDOWS) {
        this.lowFpsStreak = 0;
        reportAnomaly('cpu', `sustained low fps ~${fps.toFixed(0)} (<${fpsWarn}) for ${Math.round((WINDOW_MS * SUSTAIN_WINDOWS) / 1000)}s`, {
          fps: Math.round(fps), thresholdFps: fpsWarn, sustainedMs: WINDOW_MS * SUSTAIN_WINDOWS,
        });
        log.warn(`sustained low fps ~${fps.toFixed(0)}`);
      }
    } else {
      this.lowFpsStreak = 0;
    }
  };
}
