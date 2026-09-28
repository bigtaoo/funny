/**
 * adaptiveResolution.ts — drop the renderer from resolution 2 to 1.5 on a device that cannot hold
 * a frame rate at 2 (ADR-100).
 *
 * The case that prompted it (2026-09-28): an iPad (768x1024 CSS, dpr 2, backbuffer 2048x1308)
 * reported 16-20 fps in battles. At resolution 2 every frame fills 4x the CSS pixel count; at 1.5
 * it is 2.25x, i.e. 44% fewer pixels shaded, for a picture drawn in 1-3 px ink strokes where the
 * difference reads as "slightly softer", not as blur.
 *
 * Deliberately narrow, because a false positive costs picture quality for the rest of the session:
 *  - **Live scenes only** (`paintMode === 'live'`: the battle). Reactive screens skip frames on
 *    purpose, so their frame gaps say nothing about what the device can do.
 *  - **Median over a 5 s window**, after 3 s of warm-up in the scene. A scene's first frames (texture
 *    uploads, text rasterization) and isolated hitches are excluded by construction — a median of
 *    a window needs half the window to be slow. Gaps over {@link STALL_MS} are left out as well:
 *    those are stalls, which a lower resolution does not fix.
 *  - **Below 24 fps** (median gap > 41.7 ms). A browser that caps rAF at 30 Hz (Safari in Low Power
 *    Mode — the iPad above reported `fpsMax 30`) sits at a steady 33 ms and never trips it; a 60 Hz
 *    device settling at 30 does not either. It takes a device that is genuinely struggling.
 *  - **Once per session, one step, down only.** No oscillation, no stepping back up mid-battle.
 *
 * Applying it: the backbuffer is resized at the new resolution, and {@link setTextResolution} makes
 * new labels rasterize at it. Existing labels re-rasterize on their next render (PIXI's
 * `autoResolution`) and page bakes re-key on the new `pageBakeResolution()` — a one-off cost on the
 * frame of the switch, paid once. The switch is reported (`render_res_down`) with the fps that
 * triggered it, so the field data says how often it fires and whether it helped.
 */
import type * as PIXI from 'pixi.js-legacy';
import type { PaintMode } from './renderPolicy';
import { setTextResolution } from './pixiText';

/** Resolution the renderer drops to. */
export const LOW_RESOLUTION = 1.5;
/** Frames in a live scene before the window may start (scene construction, first uploads). */
export const WARMUP_MS = 3_000;
/** Length of one judging window. */
export const WINDOW_MS = 5_000;
/** Median frame gap above this = sustained below 24 fps. */
export const SLOW_GAP_MS = 1000 / 24;
/** A gap longer than this is a stall (GC, upload, tab hiccup), not frame-rate load — not sampled. */
export const STALL_MS = 250;
/** Fewest samples a window needs before it may judge (5 s at 10 fps). */
export const MIN_SAMPLES = 50;

/** What the governor decided at the end of a window. */
export interface DowngradeDecision {
  from: number;
  to: number;
  /** The window's median fps, i.e. what triggered the switch. */
  fps: number;
}

/**
 * The decision logic, free of PIXI and of the clock so it can be driven frame by frame in a test.
 * Feed it every frame; it returns a decision exactly once, on the frame a window closes slow.
 */
export class ResolutionGovernor {
  private liveSince = -1;
  private windowStart = -1;
  private gaps: number[] = [];
  private done = false;

  constructor(private readonly startResolution: number) {
    // Nothing to gain at or below the target — a dpr-1 (or WeChat, hardcoded 1) renderer never judges.
    if (!(startResolution > LOW_RESOLUTION + 0.01)) this.done = true;
  }

  /** True once the governor has either switched or can never switch. */
  get settled(): boolean { return this.done; }

  /**
   * One frame. `live` is false for reactive scenes and hidden tabs — either resets the window, so a
   * decision is only ever made on one uninterrupted stretch of a live scene.
   */
  frame(nowMs: number, gapMs: number, live: boolean): DowngradeDecision | null {
    if (this.done) return null;
    if (!live) {
      this.liveSince = -1;
      this.windowStart = -1;
      this.gaps.length = 0;
      return null;
    }
    if (this.liveSince < 0) { this.liveSince = nowMs; return null; }
    if (nowMs - this.liveSince < WARMUP_MS) return null;
    if (this.windowStart < 0) { this.windowStart = nowMs; this.gaps.length = 0; return null; }
    if (gapMs > 0 && gapMs <= STALL_MS) this.gaps.push(gapMs);
    if (nowMs - this.windowStart < WINDOW_MS) return null;

    const gaps = this.gaps;
    this.windowStart = nowMs;
    this.gaps = [];
    if (gaps.length < MIN_SAMPLES) return null;
    gaps.sort((a, b) => a - b);
    const med = gaps[gaps.length >> 1]!;
    if (med <= SLOW_GAP_MS) return null;
    this.done = true;
    return { from: this.startResolution, to: LOW_RESOLUTION, fps: Math.round(1000 / med) };
  }
}

/** The parts of the renderer this touches. */
interface ResizableRenderer {
  resolution: number;
  screen: { width: number; height: number };
  resize(w: number, h: number): void;
}

/**
 * Change the renderer's resolution in place. The CSS size stays (`autoDensity`), only the
 * backbuffer is reallocated.
 */
export function applyRendererResolution(renderer: ResizableRenderer, resolution: number): void {
  const { width, height } = renderer.screen;
  renderer.resolution = resolution;
  renderer.resize(width, height);
  setTextResolution(resolution);
}

/**
 * Wire a governor to the app ticker. `onDowngrade` runs after the switch (reporting, keeping the
 * render profile's resolution honest).
 */
export function installAdaptiveResolution(
  app: { renderer: unknown; ticker: PIXI.Ticker },
  paintMode: () => PaintMode | undefined,
  onDowngrade: (d: DowngradeDecision) => void,
): void {
  const renderer = app.renderer as ResizableRenderer;
  const gov = new ResolutionGovernor(renderer.resolution);
  if (gov.settled) return;
  const hidden = () => typeof document !== 'undefined' && document.hidden === true;
  const onTick = () => {
    const d = gov.frame(performance.now(), app.ticker.elapsedMS, (paintMode() ?? 'live') === 'live' && !hidden());
    if (d) {
      applyRendererResolution(renderer, d.to);
      onDowngrade(d);
    }
    if (gov.settled) app.ticker.remove(onTick);
  };
  app.ticker.add(onTick);
}
