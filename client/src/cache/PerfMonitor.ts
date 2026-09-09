import * as PIXI from 'pixi.js-legacy';
import { netLog } from '../net/log';
import { reportAnomaly, getActiveScene } from '../net/anomaly';
import { debugNum } from '../debugFlags';
import { renderStats } from '../render/renderStats';
import * as analytics from '../analytics';

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

// ── render_profile (ADR-083 follow-up) ────────────────────────────────────────
// The anomaly paths above only fire when something is WRONG, which cannot answer "what frame rate and
// paint rate does this build actually run at on an iPhone / inside WeChat" — the question ADR-083 left
// open, and the one its dpr cap (iOS/web only: WechatPlatform.devicePixelRatio is hardcoded to 1) and
// its demand-driven painting were never measured against on real hardware. So a healthy build reports
// its own numbers too: a periodic aggregate of the SAME 2s windows the watchdog already samples, plus
// the paint counters from render/renderPolicy.ts, tagged with the active scene.
//
// Volume is bounded rather than continuous: first report after FIRST_PROFILE_WINDOWS (≈30s — long
// enough for boot and the first scene to settle, short enough that a short session still reports),
// then one every PROFILE_EVERY_WINDOWS (≈5min), at most MAX_PROFILES_PER_SESSION. Only windows that
// were fully visible contribute, for the same reason the watchdog discards hidden ones: a throttled
// background tab reports a fake 4fps.
const FIRST_PROFILE_WINDOWS = 15;   // ≈30s of visible sampling
const PROFILE_EVERY_WINDOWS = 150;  // ≈5min of visible sampling
const MAX_PROFILES_PER_SESSION = 6;



/**
 * Static renderer facts app.ts knows and this module does not: the resolution the backbuffer was
 * actually created at (already through `rendererResolution`'s cap), the raw device pixel ratio it was
 * capped from, and the backbuffer size in device pixels. Passed in rather than read off a global so
 * the profile reports what SHIPPED on this device instead of what a re-derivation would guess.
 */
export interface RenderProfileInfo {
  /** `app.renderer.resolution` — post-cap (MAX_RENDER_RESOLUTION). */
  resolution: number;
  /** `platform.devicePixelRatio` — pre-cap. Differs from `resolution` exactly where the cap bit. */
  dpr: number;
  /** Backbuffer size in device pixels (`app.view.width/height`). */
  canvasW: number;
  canvasH: number;
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
  /** Latched (not sampled) hidden flag for the current window — same rationale as anomaly.ts's installAnrWatchdog: a backgrounded/occluded
   *  tab is throttled by the browser to save power, which tanks the ticker's real fps without any actual JS slowness. Sampling
   *  document.hidden only at window-end would miss a tab that was hidden mid-window and became visible again before the tick fires. */
  private hiddenSinceLastWindow = this.isHiddenNow();
  /** Static renderer facts for `render_profile`, handed in by app.ts (see {@link RenderProfileInfo}). */
  private renderInfo: RenderProfileInfo | null = null;
  /** fps of every visible window since the last profile report — sorted at report time for a median. */
  private fpsSamples: number[] = [];
  /** Total ms those windows covered (not wall time: hidden windows are excluded). */
  private profileSpanMs = 0;
  /** Visible windows since the last profile report. */
  private windowsSinceProfile = 0;
  /** `renderStats()` at the last report, to diff paints/ticks into per-second rates. */
  private lastPaintCounters: { ticks: number; painted: number } | null = null;
  private profilesSent = 0;
  private onVisibilityChange = (): void => { if (this.isHiddenNow()) this.hiddenSinceLastWindow = true; };
  private onFreeze = (): void => { this.hiddenSinceLastWindow = true; };

  install(ticker: PIXI.Ticker, renderInfo?: RenderProfileInfo): void {
    this.ticker = ticker;
    this.renderInfo = renderInfo ?? null;
    this.seedPaintCounters();
    ticker.add(this.onTick);
    this.installLongTaskObserver();
    globalThis.document?.addEventListener?.('visibilitychange', this.onVisibilityChange);
    globalThis.document?.addEventListener?.('freeze', this.onFreeze);
  }

  /** Baseline for the paint-rate diff, taken as soon as a `RenderPolicy` has published its counters. */
  private seedPaintCounters(): void {
    const rs = renderStats();
    this.lastPaintCounters = rs ? { ticks: rs.ticks, painted: rs.painted } : null;
  }

  uninstall(): void {
    this.ticker?.remove(this.onTick);
    this.ticker = null;
    try { this.observer?.disconnect(); } catch { /* ignore */ }
    this.observer = null;
    globalThis.document?.removeEventListener?.('visibilitychange', this.onVisibilityChange);
    globalThis.document?.removeEventListener?.('freeze', this.onFreeze);
  }

  private isHiddenNow(): boolean {
    return (globalThis as { document?: { hidden?: boolean } }).document?.hidden === true;
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
    // Late-seed the paint-counter baseline. app.ts constructs this monitor BEFORE `RenderPolicy`,
    // which is what publishes the counters (`setLiveRenderStats`), so `install()` above almost always
    // finds none — and a null baseline silently drops `tickPerSec`/`paintPerSec`/`skipPct` from the
    // report. That is the FIRST report, which is the only one a session shorter than ~5.5 minutes ever
    // sends, so in practice the two fields ADR-084 exists to deliver were never arriving (confirmed
    // against the one real `render_profile` in prod: fps fields present, paint fields absent).
    // Retried per tick rather than fixed by reordering app.ts, because the ordering is not this
    // module's to depend on: it must report paint rates whenever the policy installs, before or after.
    if (this.lastPaintCounters === null) this.seedPaintCounters();
    this.frames += 1;
    this.accMs += this.ticker?.deltaMS ?? 16.7;
    if (this.accMs < WINDOW_MS) return;

    const windowMs = this.accMs;
    const fps = (this.frames * 1000) / windowMs;
    const busyRatio = Math.min(1, this.longTaskMs / windowMs);
    this.accMs = 0;
    this.frames = 0;
    this.longTaskMs = 0;

    // The tab was hidden/backgrounded/occluded at some point during this window: the browser throttles
    // rAF for power saving, which can legitimately tank fps and stretch deltaMS with no real JS slowness.
    // Discard this window's sample entirely rather than let it count toward either signal or the streak.
    if (this.hiddenSinceLastWindow) {
      this.hiddenSinceLastWindow = this.isHiddenNow();
      this.lowFpsStreak = 0;
      // Also drop it from the profile aggregate: a throttled background tab would otherwise report
      // a fake 4fps as if the device were struggling.
      return;
    }

    this.fpsSamples.push(fps);
    this.profileSpanMs += windowMs;
    this.windowsSinceProfile += 1;
    this.maybeReportProfile();

    // ① Long-task busy ratio: report immediately if the threshold is breached in a single window (a long task is hard evidence of a saturated main thread).
    if (this.observer && busyRatio >= debugNum('nw_cpu_busy_warn', DEFAULT_BUSY_WARN)) {
      reportAnomaly('cpu', `main-thread busy ${(busyRatio * 100).toFixed(0)}% over ${Math.round(windowMs)}ms`, {
        busyRatio: Math.round(busyRatio * 100) / 100, windowMs: Math.round(windowMs), fps: Math.round(fps),
      });
      log.warn(`main-thread busy ${(busyRatio * 100).toFixed(0)}%`, { fps: Math.round(fps) });
      return; // already reported; do not also trigger the FPS path for this window
    }

    // ② Sustained low FPS: report only after multiple consecutive windows (transient drops or scene transitions do not count).
    const fpsWarn = debugNum('nw_fps_warn', DEFAULT_FPS_WARN);
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

  /**
   * Emit one `render_profile` when enough visible windows have accumulated (see the constants above).
   *
   * Everything here is derived from samples the watchdog was already taking, plus a diff of
   * `renderStats()`, so a healthy session pays one array sort and one analytics event per report.
   */
  private maybeReportProfile(): void {
    if (this.profilesSent >= MAX_PROFILES_PER_SESSION) return;
    const due = this.profilesSent === 0 ? FIRST_PROFILE_WINDOWS : PROFILE_EVERY_WINDOWS;
    if (this.windowsSinceProfile < due) return;

    const sorted = [...this.fpsSamples].sort((a, b) => a - b);
    const spanS = this.profileSpanMs / 1000;
    const props: Record<string, unknown> = {
      scene: getActiveScene() || 'unknown',
      spanS: Math.round(spanS),
      windows: this.windowsSinceProfile,
      fpsP50: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
      fpsMin: Math.round(sorted[0] ?? 0),
      fpsMax: Math.round(sorted[sorted.length - 1] ?? 0),
      maxFps: this.ticker?.maxFPS ?? 0,
    };
    if (this.renderInfo) {
      props.res = this.renderInfo.resolution;
      props.dpr = this.renderInfo.dpr;
      // The single number saying whether ADR-083's dpr cap did anything on this device.
      props.dprCapped = this.renderInfo.dpr > this.renderInfo.resolution;
      props.canvasW = this.renderInfo.canvasW;
      props.canvasH = this.renderInfo.canvasH;
    }
    // Paint rate: the whole point of demand-driven painting is that this sits BELOW the tick rate on
    // a menu and equals it in a battle. Absent when no RenderPolicy is installed (tests, tools).
    const rs = renderStats();
    if (rs && this.lastPaintCounters && spanS > 0) {
      const dTicks = rs.ticks - this.lastPaintCounters.ticks;
      const dPaints = rs.painted - this.lastPaintCounters.painted;
      if (dTicks > 0) {
        props.tickPerSec = Math.round(dTicks / spanS);
        props.paintPerSec = Math.round(dPaints / spanS);
        props.skipPct = Math.round(((dTicks - dPaints) / dTicks) * 100);
      }
    }
    if (rs) this.lastPaintCounters = { ticks: rs.ticks, painted: rs.painted };

    analytics.track('render_profile', props);
    log.info('render_profile', props);

    this.profilesSent += 1;
    this.fpsSamples = [];
    this.profileSpanMs = 0;
    this.windowsSinceProfile = 0;
  }
}
