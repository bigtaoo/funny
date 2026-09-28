import * as PIXI from 'pixi.js-legacy';
import { netLog } from '../net/log';
import { reportAnomaly, getActiveScene, takeFrameCost, type RenderMaxDetail } from '../net/anomaly';
import { debugNum } from '../debugFlags';
import { framePacing, renderStats } from '../render/renderStats';
import * as analytics from '../analytics';

// Runtime CPU / main-thread saturation monitor: browsers expose no direct CPU usage API; the observable equivalent signal is "main thread fully occupied".
// Two parallel sampling paths; if either sustains a threshold breach, one cpu anomaly is reported (reportAnomaly → full-volume channel → Loki):
//
//   ① Long-task busy ratio (Chromium only / where PerformanceObserver('longtask') is supported): sum of all >50ms
//      main-thread long-task durations within the window ÷ window length. A high ratio means the main thread is saturated by JS = perceived "CPU spike / stutter".
//   ② Sustained low FPS (available everywhere, including WeChat): estimates per-window FPS from ticker.deltaMS over full-rate
//      stretches only (idle-throttled ones are excluded, see MIN_FULL_RATE_MS); sustained low FPS across multiple consecutive windows triggers a stutter report.
//      Environments that don't support longtask (WeChat) fall back to this path.
//
// Structurally mirrors MemoryMonitor: attached to app.ticker, persists across scenes, cooldown prevents alert flooding (reportAnomaly already applies a 60s cooldown for cpu-class events).
// Thresholds can be overridden via localStorage 'nw_fps_warn' (FPS below this value is considered a stutter) / 'nw_cpu_busy_warn' (long-task busy ratio 0~1).

const log = netLog('perf');

const DEFAULT_FPS_WARN = 25;        // sustained FPS below this is considered a stutter (5fps headroom to avoid false positives on 30Hz locked devices)
const DEFAULT_BUSY_WARN = 0.5;      // long-task busy ratio ≥ this value is considered main-thread saturation
const WINDOW_MS = 2_000;            // sampling window
const SUSTAIN_WINDOWS = 5;          // report only after this many consecutive low-FPS windows (≈10s), to avoid reporting transient spikes
/**
 * fps is measured over FULL-RATE frame intervals only (ADR-095, 2026-09-28).
 *
 * `render/renderPolicy.ts` drops the loop to IDLE_FPS (20) on a screen whose picture has not changed
 * for two seconds, and re-arms 60 on the very tick anything changes. Those 20fps stretches paint
 * nothing new: the device was asked to go slow, it is not failing to go fast. Counting them made
 * every idle menu read as a 60->20 "stutter", in the watchdog and in `render_profile` alike. Two
 * earlier patches clamped the watchdog threshold under the lowest cap seen in the window
 * (`FPS_WARN_HEADROOM` / `windowMinCap`, ADR-086 and 2026-09-12). They stopped the false alarms but
 * left `fpsP50: 20` in the report for a human to explain away against `maxFps`. Measuring only the
 * stretches where the picture can move removes the question instead, so the threshold is a plain
 * constant again.
 *
 * An interval counts only if `renderStats().idle` was false at BOTH of its ends, as seen from this
 * listener. That drops the interval entering idle, every idle one, and the one waking from it (half
 * of which is a 50ms idle gap, however the wake happened). A wake the policy notices by itself costs
 * one genuinely full-rate interval too; dropping a good frame is cheaper than counting a bad one.
 *
 * Unrelated to idle and still real: the 2026-09-11 dpr-2 / 2048x1308 device reporting
 * `maxFps:60, fpsP50:30, fpsMax:30` ran at its ceiling of 60 the whole span and never got there.
 * Cross-check a `cpu` anomaly against `render_profile`'s `hz` and `maxFps` vs `fpsMax`.
 */
const MIN_FULL_RATE_MS = 500;

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
/** `rndMax` at or above this carries its split (`rndMaxTex/Sh/Txt/Geo/Scene/At`); 3+ frames at 60 Hz. */
const RND_MAX_DETAIL_MS = 50;



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
  /**
   * Set once render/adaptiveResolution.ts has dropped the resolution this session: the value it
   * started at. `resolution` / `canvasW/H` are then the lowered ones (ADR-100).
   */
  resFrom?: number;
}

/** Median of an unsorted sample array. Copies: `sort` mutates, and these arrays are still in use. */
function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** 0.1ms resolution — finer than that is noise on a `performance.now()` pair, and costs report size. */
function round1(ms: number): number { return Math.round(ms * 10) / 10; }

interface LongTaskEntry { duration: number }
interface PerfObserver { observe(opts: { entryTypes: string[] }): void; disconnect(): void }

/** Application-wide singleton CPU / main-thread saturation monitor. Installed once via install(app.ticker) in app.ts; persists across scenes. */
export class PerfMonitor {
  private ticker: PIXI.Ticker | null = null;
  private accMs = 0;
  private frames = 0;
  /** Full-rate intervals of the current window and the ms they covered: the fps sample. See {@link MIN_FULL_RATE_MS}. */
  private fullMs = 0;
  private fullFrames = 0;
  /** `renderStats().idle` as seen on the previous tick: an interval counts only if both its ends were full rate. */
  private idleAtLastTick = false;
  /** Highest pacer cap seen on a full-rate interval since the last profile: `render_profile.maxFps`. */
  private spanMaxCap = 0;
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
  /**
   * Per-tick `scene.update()` and `renderer.render()` cost (ms), one entry per visible window.
   *
   * One entry PER WINDOW, not per frame, for the same reason `fpsSamples` is: a 5-minute report at
   * 60fps would otherwise retain 18,000 numbers to compute one median from. A window mean is the
   * resolution this report has always had, and the question it answers — "is the frame budget going
   * into our JS at all" — does not need a finer one.
   */
  private updSamples: number[] = [];
  private rndSamples: number[] = [];
  /** Worst single `update()` / `render()` call across every visible window since the last report. */
  private updMaxMs = 0;
  private rndMaxMs = 0;
  /** Split of the render behind {@link rndMaxMs}: `render_profile.rndMaxTex/Sh/Txt/Geo/Scene/At`. */
  private rndMaxDetail: RenderMaxDetail | null = null;
  /** Total ms those windows covered (not wall time: hidden windows are excluded). */
  private profileSpanMs = 0;
  /** Of {@link profileSpanMs}, the ms that were NOT full rate: `render_profile.idlePct`. */
  private profileIdleMs = 0;
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
    const dt = this.ticker?.deltaMS ?? 16.7;
    this.frames += 1;
    this.accMs += dt;
    // Sampled per tick, not at window end: the policy flips idle on a single tick. See MIN_FULL_RATE_MS.
    const idleNow = renderStats()?.idle ?? false;
    if (!idleNow && !this.idleAtLastTick) {
      this.fullFrames += 1;
      this.fullMs += dt;
      const cap = framePacing()?.capFps ?? 0;
      if (cap > this.spanMaxCap) this.spanMaxCap = cap;
    }
    this.idleAtLastTick = idleNow;
    if (this.accMs < WINDOW_MS) return;

    const windowMs = this.accMs;
    const frames = this.frames;
    const fullMs = this.fullMs;
    // null = this window was (almost) all idle: no fps to report, and nothing for the watchdog to judge.
    const fps = fullMs >= MIN_FULL_RATE_MS ? (this.fullFrames * 1000) / fullMs : null;
    const busyRatio = Math.min(1, this.longTaskMs / windowMs);
    // Taken unconditionally, BEFORE the hidden-window bail below: the accumulator is reset-on-read,
    // so a window this monitor throws away must still be drained or its cost leaks into the next one
    // and a hidden window is exactly the one whose numbers must not survive.
    const cost = takeFrameCost();
    this.accMs = 0;
    this.frames = 0;
    this.fullMs = 0;
    this.fullFrames = 0;
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

    if (fps !== null) this.fpsSamples.push(fps);
    this.profileIdleMs += Math.max(0, windowMs - fullMs);
    // Divided by this window's TICK count, not by the number of calls: `updMs` sums one call per
    // mounted scene (a scene plus its overlay is two), and `rndMs` sums only the ticks that actually
    // painted. Both therefore read as "ms of this work per tick", directly comparable to the frame
    // period 1000/fps — which is the comparison the whole field exists for.
    this.updSamples.push(cost.updMs / frames);
    this.rndSamples.push(cost.rndMs / frames);
    if (cost.updMaxMs > this.updMaxMs) this.updMaxMs = cost.updMaxMs;
    if (cost.rndMaxMs > this.rndMaxMs) { this.rndMaxMs = cost.rndMaxMs; this.rndMaxDetail = cost.rndMaxDetail ?? null; }
    this.profileSpanMs += windowMs;
    this.windowsSinceProfile += 1;
    this.maybeReportProfile();

    // ① Long-task busy ratio: report immediately if the threshold is breached in a single window (a long task is hard evidence of a saturated main thread).
    if (this.observer && busyRatio >= debugNum('nw_cpu_busy_warn', DEFAULT_BUSY_WARN)) {
      reportAnomaly('cpu', `main-thread busy ${(busyRatio * 100).toFixed(0)}% over ${Math.round(windowMs)}ms`, {
        busyRatio: Math.round(busyRatio * 100) / 100, windowMs: Math.round(windowMs),
        ...(fps !== null ? { fps: Math.round(fps) } : {}),
      });
      log.warn(`main-thread busy ${(busyRatio * 100).toFixed(0)}%`, fps !== null ? { fps: Math.round(fps) } : {});
      return; // already reported; do not also trigger the FPS path for this window
    }

    // ② Sustained low FPS: report only after multiple consecutive windows (transient drops or scene transitions do not count).
    // An idle window neither extends nor breaks the streak: it says nothing about how fast the device can paint.
    if (fps === null) return;
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
      // The ceiling the fps below was measured under: the highest cap on a full-rate interval, i.e.
      // TARGET_FPS in practice. Falls back to the cap at report time for a span that was idle
      // throughout (ADR-095; before it, this was always the report-time cap and could read 20).
      maxFps: this.spanMaxCap || (framePacing()?.capFps ?? 0),
      // Share of the span held at IDLE_FPS. Power is read here, smoothness from fpsP50: two
      // questions that used to share one number.
      idlePct: this.profileSpanMs > 0 ? Math.round((this.profileIdleMs / this.profileSpanMs) * 100) : 0,
    };
    // Full-rate stretches only (ADR-095). Absent, not 0, for a span that never ran at full rate.
    if (sorted.length) {
      props.fpsP50 = Math.round(sorted[Math.floor(sorted.length / 2)]!);
      props.fpsMin = Math.round(sorted[0]!);
      props.fpsMax = Math.round(sorted[sorted.length - 1]!);
    }
    // Estimated display refresh rate (ADR-094). Absent without a pacer rather than a made-up 60.
    const pacing = framePacing();
    if (pacing) props.hz = Math.round(pacing.refreshHz);
    if (this.renderInfo) {
      props.res = this.renderInfo.resolution;
      props.dpr = this.renderInfo.dpr;
      // The single number saying whether ADR-083's dpr cap did anything on this device.
      props.dprCapped = this.renderInfo.dpr > this.renderInfo.resolution;
      props.canvasW = this.renderInfo.canvasW;
      props.canvasH = this.renderInfo.canvasH;
      if (this.renderInfo.resFrom !== undefined) props.resFrom = this.renderInfo.resFrom;
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

    // Where the frame budget went. Read these AGAINST THE FRAME PERIOD (1000 / fpsP50):
    //   updP50 + rndP50 ≈ the frame period  → the main thread is the bottleneck, and the work is ours
    //                                          to cut (a scene's update, or draw-call submission).
    //   updP50 + rndP50 ≪ the frame period  → the time is NOT in our JS. A display capped below
    //                                          `maxFps`, GPU fill rate, or the compositor — and no
    //                                          amount of JS optimisation will move `fpsP50`.
    // This fork is the one the 2026-09-11 dpr-2 / 2048x1308 session could not be read across, which
    // is how it got diagnosed twice from mechanism alone and corrected twice. `fpsMax` vs `maxFps`
    // says whether we are reaching the ceiling; these two say who is holding us back from it.
    if (this.updSamples.length) {
      props.updP50 = round1(median(this.updSamples));
      props.updMax = round1(this.updMaxMs);
      props.rndP50 = round1(median(this.rndSamples));
      props.rndMax = round1(this.rndMaxMs);
      // Only for a frame worth explaining: below this the split is noise and five fields per row.
      const d = this.rndMaxDetail;
      if (d && this.rndMaxMs >= RND_MAX_DETAIL_MS) {
        props.rndMaxTex = round1(d.texMs);
        props.rndMaxSh = round1(d.shMs);
        props.rndMaxTxt = round1(d.txtMs);
        props.rndMaxGeo = round1(d.geoMs);
        props.rndMaxScene = d.scene;
        props.rndMaxAt = round1(d.atS);
      }
    }

    analytics.track('render_profile', props);
    log.info('render_profile', props);

    this.profilesSent += 1;
    this.fpsSamples = [];
    this.updSamples = [];
    this.rndSamples = [];
    this.updMaxMs = 0;
    this.rndMaxMs = 0;
    this.rndMaxDetail = null;
    this.profileSpanMs = 0;
    this.profileIdleMs = 0;
    this.spanMaxCap = 0;
    this.windowsSinceProfile = 0;
  }
}
