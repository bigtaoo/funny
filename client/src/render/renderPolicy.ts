/**
 * renderPolicy.ts — how often the canvas is painted, and at what pixel density.
 *
 * The problem this exists to fix (measured 2026-09-08, real Chrome, idle lobby, dpr 1.5,
 * 1280×631 CSS = 1920×947 device px): PIXI's `Application` paints the whole stage on every
 * `requestAnimationFrame`, forever, whether or not anything on screen changed — 23 draw calls
 * and 253,737 indices per frame, ~0.8 ms GPU + ~0.8 ms main thread, for a menu that is
 * standing still. There was no `maxFPS`, so a 120 Hz phone or a ProMotion Mac paid that bill
 * twice over, and `resolution` was the raw `devicePixelRatio`, so a dpr-3 phone rasterised
 * four times the pixels this desktop measurement did. Sustained, never-idling GPU work is
 * exactly what drains a battery and spins a fan.
 *
 * Three knobs, in increasing order of how much they can go wrong:
 *
 * 1. {@link rendererResolution} — cap the backbuffer at {@link MAX_RENDER_RESOLUTION}. Pure
 *    fill-rate saving, no behavioural risk. The art style is hand-drawn ink at ~2 px stroke
 *    widths; dpr 3 buys nothing a reader can see.
 * 2. A {@link TARGET_FPS} cap — halves the frame count on every 120 Hz device. `dt` is unaffected
 *    in kind (every consumer already integrates `deltaMS`), only its distribution changes, so no
 *    simulation reads differently. Enforced by `render/framePacer.ts` as a whole-number divisor of
 *    the refresh rate, not by PIXI's `ticker.maxFPS` (ADR-094: that throttle drops ~2% of frames
 *    at 60 Hz).
 * 3. Demand-driven painting for scenes that declare `paint: 'reactive'` (see `Scene.paint` in
 *    scenes/SceneManager.ts): the stage is painted only when it actually CHANGED.
 *
 * ── Why (3) is a derivation and not a `markDirty()` protocol ──────────────────
 *
 * The obvious design is an `invalidate()` call at every site that mutates the display list.
 * With ~40 scenes, each rebuilding on input / network pushes / late texture decodes, "remember
 * to call it" is precisely the shape of bug this repo keeps paying for (see `SceneManager.onTick`
 * on why BGM is derived every frame instead of being notified). A missed call would not be a
 * cosmetic slip either: it would freeze the picture, which is the single worst failure mode this
 * client has shipped (the "UI switch freezes, only a reload recovers" report).
 *
 * So instead of trusting call sites, {@link stageSignature} DERIVES "did the picture change" from
 * the scene graph itself, once per tick, from the same fields the renderer reads: visibility,
 * alpha, tint, local transform ids, texture identity + upload counter, `Graphics` geometry
 * revision, `Text` content, child count and order. It is one allocation-free walk — 95 objects in
 * the lobby, microseconds — and it is only ever run for scenes that opted in.
 *
 * And because a derivation can still be incomplete (a change nothing in that list reflects), the
 * gate has a **floor**: {@link IDLE_FLOOR_MS} forces a paint even when the signature is unchanged,
 * plus any pointer event holds the full frame rate for {@link ACTIVE_AFTER_INPUT_MS}. The worst
 * case for a miss is therefore a frame that lands late, never a frame that never lands.
 */
import * as PIXI from 'pixi.js-legacy';
import { debugFlag } from '../debugFlags';
import { setLiveFramePacing, setLiveRenderStats, type RenderStats } from './renderStats';
import { FramePacer, type FrameScheduler } from './framePacer';
import { setDecorationsQuiet } from './idleQuiet';
import { stageSignature, lastWalkRenderMutates } from './stageSignature';

/**
 * Backbuffer resolution ceiling. 2 keeps text and ink crisp on every retina-class display;
 * above that the extra pixels are pure fill-rate cost (a dpr-3 phone rasterises 2.25× the area
 * of a dpr-2 one for the same picture).
 */
export const MAX_RENDER_RESOLUTION = 2;

/**
 * GPU the WebGL context asks for.
 *
 * PIXI's default (`settings.RENDER_OPTIONS.powerPreference`) is `'default'`, which hands the choice
 * to the browser — and on a dual-GPU Intel Mac that is how a 2D notebook-sketch game ends up
 * spinning the discrete GPU and its fans. `'low-power'` asks for the integrated one instead. This
 * client's heaviest frame is ~18k indices and ~0.5 ms of GPU time; integrated is not close to being
 * the limit, so there is nothing to trade away.
 *
 * On single-GPU hardware (Apple Silicon, phones, most PCs) the hint does nothing at all — this is a
 * cheap hedge against a specific machine class, NOT a diagnosed cause of the 2026-09-08 fan report.
 */
export const POWER_PREFERENCE = 'low-power' as const;

/** Frame-rate ceiling. 60 on a 120 Hz panel is half the power for a look authored at ~8-24 fps. */
export const TARGET_FPS = 60;

/**
 * Hard paint floor for a `reactive` scene: even with the signature unchanged, paint at least this
 * often. This is the safety valve that turns "the change detector missed something" from a frozen
 * screen into a frame up to half a second late.
 */
export const IDLE_FLOOR_MS = 500;

/**
 * After any pointer event, paint every tick for this long. Covers the whole class of "the change
 * arrives a beat after the input" — scroll momentum consumed in `update(dt)`, a rebuild deferred to
 * the next frame by a dirty flag, a texture that decodes mid-gesture — without asking any of them
 * to announce themselves.
 */
export const ACTIVE_AFTER_INPUT_MS = 400;

/**
 * Tick-rate ceiling once a `reactive` screen has been standing still for {@link IDLE_QUIET_MS}.
 *
 * Demand-driven painting removed the `render()` call from an idle frame but not the frame itself:
 * `SceneManager.onTick` (transition step, BGM derivation, every mounted scene's `update`) and the
 * {@link stageSignature} walk still ran 60 times a second on a picture that was not moving. 20 Hz
 * is the same "hand-drawn does not need to be smooth" call art-direction §5.4 makes everywhere
 * else, applied to the loop rather than to one animation, and it cuts that leftover work to a
 * third. The cost is detection latency: a change nothing announced — a network push landing on a
 * quiet screen — is noticed up to 50 ms late instead of up to 17 ms late.
 *
 * Anything that paints for a real reason ('hold' / 'changed' / a `live` scene) puts the rate back
 * to {@link TARGET_FPS} on the same tick, and {@link holdRenderActive} does it synchronously from
 * the pointer event, before the next frame — so the throttle can never add latency to input.
 */
export const IDLE_FPS = 20;

/**
 * How long a `reactive` screen must go without a real paint before {@link IDLE_FPS} applies.
 *
 * The {@link IDLE_FLOOR_MS} paint deliberately does NOT count as a real one: it is the "we believe
 * nothing changed" valve, so treating it as activity would re-arm full frame rate twice a second
 * and the throttle would never engage at all.
 */
export const IDLE_QUIET_MS = 2_000;

/**
 * How long without any pointer event before purely decorative motion holds its frame
 * (`render/idleQuiet.ts`).
 *
 * This is the half of the idle budget the tick-rate cap alone cannot reach: the lobby's boiling
 * lines (8 fps), its stickman silhouettes (12 fps) and the world map's shield bubbles (30 fps) each
 * change the stage signature on their own schedule, which is what keeps an untouched screen
 * painting 5-12 times a second AND keeps it above the quiet threshold above. With them holding, an
 * untouched screen paints only on the 500 ms floor — twice a second — and the tick cap engages.
 *
 * 30 s rather than a few: a menu the player is actively reading should still be alive, and the case
 * this exists for is the app left open in a pocket or on a second monitor for minutes.
 */
export const DECOR_QUIET_AFTER_MS = 30_000;

/**
 * A hold with more than this left will certainly still be holding on the next tick, so the paint
 * needs no baseline (see `RenderPolicy.baselineAfterPaint`). One {@link IDLE_FPS} period: the
 * longest gap between two ticks the pacer schedules. A late frame past it costs one extra paint.
 */
const HOLD_WALK_MARGIN_MS = 1000 / IDLE_FPS;

/** How a scene wants to be painted. See `Scene.paint`. */
export type PaintMode = 'live' | 'reactive';

/**
 * The slice of `PIXI.Application` this module drives. Narrowed to an interface so the policy can be
 * unit-tested against a stub host with a real `PIXI.Ticker` and a counting `render()` — there is no
 * WebGL in the headless harness, so a real `Application` cannot be constructed there.
 */
export interface RenderLoopHost {
  readonly ticker: PIXI.Ticker;
  readonly stage: PIXI.Container;
  /** The host's own paint entry point (`Application.render`). */
  render(): void;
}

// ── module-level activity seams ───────────────────────────────────────────────
// Module-level rather than instance methods for the same reason `setBakeRenderer` / `setAudioBus`
// are: the callers (InputManager, ScalingManager, SceneManager) are constructed before — or
// entirely independently of — the PIXI application, and threading a policy handle through all of
// them would be a wide change for a one-line signal.

let activeUntilMs = 0;
/** When the player last did something. Basis for {@link DECOR_QUIET_AFTER_MS}. */
let lastActivityMs = 0;
/**
 * Installed by {@link RenderPolicy.install}: restores the full tick rate the instant an activity
 * signal arrives, rather than on the next tick — which, while throttled to {@link IDLE_FPS}, could
 * be 50 ms away. Without this the first frame after a tap on a resting screen would be late.
 */
let onActivity: (() => void) | null = null;
let now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Test seam: drive the clock the policy reads. Pass nothing to restore the real one. */
export function setRenderPolicyClock(clock?: () => number): void {
  now = clock ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
}

/**
 * "The player is interacting" — paint every tick for {@link ACTIVE_AFTER_INPUT_MS}. Called from
 * `InputManager`'s four emit funnels, so every pointer path (web, WeChat, CrazyGames) is covered by
 * one call site per event kind.
 */
export function holdRenderActive(): void {
  activeUntilMs = now() + ACTIVE_AFTER_INPUT_MS;
  lastActivityMs = now();
  onActivity?.();
}

/**
 * "Something changed that the signature cannot see" — paint the next tick. Used for the handful of
 * events that mutate the picture from outside the scene graph the policy walks (a renderer resize,
 * a scene swap).
 */
export function invalidateRender(): void {
  activeUntilMs = Math.max(activeUntilMs, now() + 1);
  // Counts as activity too: the callers are a renderer resize and a scene swap, both of which mean
  // the player is somewhere new and should not arrive at frozen decorations.
  lastActivityMs = now();
  onActivity?.();
}

/**
 * How long it has been since the last real activity — a pointer event on any platform adapter
 * ({@link holdRenderActive}) or a scene swap / resize ({@link invalidateRender}).
 *
 * Already maintained for {@link DECOR_QUIET_AFTER_MS}; exported so `analytics/idleWatch.ts` can read
 * the same number instead of installing a second input hook. Analytics must not import this module
 * (it drags PIXI into the render-free app core), so app.ts passes the accessor in.
 */
export function msSinceActivity(): number {
  return now() - lastActivityMs;
}

/** True while a {@link holdRenderActive} / {@link invalidateRender} hold is still in effect. */
export function renderHoldActive(): boolean {
  return now() < activeUntilMs;
}

/** Test seam: drop any outstanding activity hold. */
export function resetRenderHold(): void {
  activeUntilMs = 0;
  lastActivityMs = now();
}

export { stageSignature, setSignatureCovered } from './stageSignature';

// ── the policy ────────────────────────────────────────────────────────────────

/** Resolution to hand `new PIXI.Application({ resolution })`, capped at {@link MAX_RENDER_RESOLUTION}. */
export function rendererResolution(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
  return Math.min(devicePixelRatio, MAX_RENDER_RESOLUTION);
}

/** What the policy did on one tick — the shape the tests assert on. */
export interface RenderTickResult {
  painted: boolean;
  /**
   * Why it painted (or didn't), for tests and for the `nw_render_debug` console counter.
   *
   * There is deliberately no 'hidden' case. A `document.hidden` short-circuit looks free — a
   * backgrounded tab should not paint — but the browser has already stopped delivering rAF by then,
   * so the check can only ever fire in the states where `hidden` is true and frames still arrive:
   * a fully occluded window that the compositor wakes for a screenshot, or a headless capture. The
   * first version of this class had it, and the whole canvas came back BLACK in exactly that state
   * (Chrome reports hidden for an occluded window; PIXI's own render listener never cared).
   */
  reason: 'live' | 'hold' | 'changed' | 'floor' | 'skipped';
}

/**
 * Takes over painting from `Application`'s own ticker listener.
 *
 * `Application`'s TickerPlugin registers `render` at `UPDATE_PRIORITY.LOW` when it is constructed;
 * we remove exactly that listener and add our own at the same priority, so the ordering every other
 * listener relies on (scene `update()` at NORMAL, then paint) is unchanged — including app.ts's
 * `renderer.render` timing wrapper, which still sees every real paint.
 */
export class RenderPolicy {
  private lastSignature = -1;
  /** What {@link decide} walked on a 'changed' tick, or -1 if render will move it. */
  private prePaintSignature = -1;
  /** The last paint's baseline was {@link prePaintSignature}, not a fresh walk. */
  private reusedBaseline = false;
  private lastPaintMs = 0;
  /** Last tick that painted for a real reason — see {@link IDLE_QUIET_MS} on why 'floor' isn't one. */
  private lastBusyMs = 0;
  /** Drives both tickers; created on {@link install}, because it takes their loops over. */
  private pacer: FramePacer | null = null;
  /** Counters exposed for the browser measurement recipe (`window.__nwRenderStats`). */
  readonly stats: RenderStats = { ticks: 0, painted: 0, skipped: 0, idle: false };

  constructor(
    private readonly host: RenderLoopHost,
    /** Current scene's paint mode; `undefined` (no scene, or a scene that never declared one) = 'live'. */
    private readonly paintMode: () => PaintMode | undefined,
    /** rAF seam for the pacer; tests pass a manual one so no real frame loop runs under them. */
    private readonly scheduler?: FrameScheduler,
  ) {}

  install(): void {
    // `Ticker.shared` first: fx that animate this frame must land before the paint that shows them.
    this.pacer = new FramePacer([PIXI.Ticker.shared, this.host.ticker], this.scheduler);
    this.pacer.install();
    setLiveFramePacing(this.pacer);
    this.setMaxFps(TARGET_FPS);
    setLiveRenderStats(this.stats);
    this.publishStats();
    // Cast: TickerPlugin's `render` is typed as a plain method, not as a TickerCallback.
    this.host.ticker.remove(this.host.render as PIXI.TickerCallback<unknown>, this.host);
    this.host.ticker.add(this.tick, this, PIXI.UPDATE_PRIORITY.LOW);
    this.lastPaintMs = now();
    this.lastBusyMs = now();
    lastActivityMs = now();
    onActivity = () => this.setMaxFps(TARGET_FPS);
  }

  uninstall(): void {
    this.host.ticker.remove(this.tick, this);
    setLiveRenderStats(null);
    setDecorationsQuiet(false);
    onActivity = null;
    this.pacer?.uninstall();
    this.pacer = null;
    setLiveFramePacing(null);
  }

  /** The installed pacer (tests, and the measurement recipe via `__nwRenderStats`). */
  get framePacer(): FramePacer | null { return this.pacer; }

  /**
   * Apply a tick-rate ceiling to BOTH loops.
   *
   * `PIXI.Application` does not use `Ticker.shared` (`sharedTicker` defaults to false), so this
   * client runs two independent `requestAnimationFrame` loops: the application's, which paints, and
   * the shared one, which `render/boil.ts` and the battle/card view fx register their animation
   * callbacks on. Only the first was ever capped, which meant the second ran flat out at the
   * display's refresh rate — 120 Hz on a ProMotion device — for as long as any lobby boiling line
   * existed. Capping it here rather than converting fourteen `Ticker.shared` call sites to a seam:
   * the power problem is the rate, and every one of those sites already integrates `deltaMS`, so a
   * lower rate changes how finely an effect is sampled and not how long it takes.
   *
   * Since ADR-094 both are driven by one {@link FramePacer}, so they also tick on the same vsync.
   */
  private setMaxFps(fps: number): void {
    if (this.pacer) this.pacer.capFps = fps;
    // Published beside the cap, never derived later from it: PerfMonitor must see a wake-up on
    // input the same instant the pacer does (ADR-095).
    this.stats.idle = fps < TARGET_FPS;
  }

  /** One frame's decision. Exposed (not just wired to the ticker) so tests can step it by hand. */
  tick = (): RenderTickResult => {
    this.stats.ticks++;
    const result = this.decide();
    this.applyIdleThrottles(result);
    if (result.painted) {
      this.host.render();
      this.lastPaintMs = now();
      this.lastSignature = this.baselineAfterPaint(result.reason);
      this.stats.painted++;
    } else {
      // A skipped tick means the reused baseline was right: the guard only arms for the tick
      // straight after a reuse, so an animation changing every other tick keeps reusing.
      this.reusedBaseline = false;
      this.stats.skipped++;
    }
    return result;
  };

  /**
   * With `localStorage.nw_render_debug` set, hang the live counters off `globalThis` so a paint rate
   * can be READ rather than inferred. Same shape of opt-in knob as `nw_mem_warn_mb` / `nw_fps_warn`,
   * and the same reason: this is the only number that says whether the gate is doing anything, and
   * without a handle the only way to get it is to re-instrument the page by hand every time (the
   * 2026-09-08 measurement session did exactly that). Off by default — nothing is published, so no
   * production build grows a debug global.
   */
  private publishStats(): void {
    // Read through debugFlags, not `globalThis.localStorage`: on WeChat the latter does not exist,
    // so this counter — the only readable evidence that the gate is working — was permanently off on
    // the host where it mattered most. See debugFlags.ts.
    if (!debugFlag('nw_render_debug')) return;
    (globalThis as { __nwRenderStats?: RenderPolicy['stats'] }).__nwRenderStats = this.stats;
    // The pacer too: `capFps` / `refreshHz` / `runs` are what a frame-pacing probe reads, and since
    // ADR-094 `ticker.maxFPS` is always 0, so it can no longer tell the app ticker apart by its cap.
    (globalThis as { __nwFramePacer?: FramePacer | null }).__nwFramePacer = this.pacer;
  }

  /**
   * The two idle knobs, decided from the same tick result the paint decision came from.
   *
   * Derived rather than announced, exactly like {@link stageSignature}: nothing has to remember to
   * say "I am busy now". A `live` scene, an input hold and a real signature change all read as
   * activity; a skipped frame and the {@link IDLE_FLOOR_MS} valve do not.
   */
  private applyIdleThrottles(result: RenderTickResult): void {
    const t = now();
    if (result.reason === 'live' || result.reason === 'hold' || result.reason === 'changed') {
      this.lastBusyMs = t;
    }
    this.setMaxFps(t - this.lastBusyMs >= IDLE_QUIET_MS ? IDLE_FPS : TARGET_FPS);
    setDecorationsQuiet(t - lastActivityMs >= DECOR_QUIET_AFTER_MS);
  }

  /**
   * The signature the next tick compares against, after a paint.
   *
   * It has to describe the tree AFTER `render()`, because render itself changes fields the walk
   * reads (a `Text` rasterises into a new frame, a `BitmapText` rebuilds its glyphs, a container
   * sorts). The first version re-walked the whole tree after every paint to get it, which on the
   * world map and the city was a third of all walking while idle and all of it while dragging
   * (ADR-101). It only has to walk when the answer could actually be used and is not already known:
   *
   * - `live` — nothing compares against it while the scene stays live, and the walk is not cheap
   *   on a live scene (ADR-096). -1 is never a signature (they are unsigned), so the first tick
   *   after a switch to a reactive scene reads as 'changed' and paints, as a switch does anyway.
   * - `hold` that will still be holding next tick — that tick paints without looking. Only the last
   *   paint of a gesture walks, so a drag across the map stops walking 60 times a second.
   * - `changed` — {@link decide} walked the tree a moment ago. If that walk saw nothing render will
   *   change, its signature IS the post-paint one. The one guard: if the tick right after such a
   *   reuse reads 'changed' again, walk for real this time. A render-side change this list does not
   *   know about therefore costs one extra paint and then settles; it can never keep a still screen
   *   painting every tick.
   * - `floor`, and a hold that is about to end — walk.
   */
  private baselineAfterPaint(reason: RenderTickResult['reason']): number {
    const reused = this.reusedBaseline;
    this.reusedBaseline = false;
    if (reason === 'live') return -1;
    if (reason === 'hold' && activeUntilMs - now() > HOLD_WALK_MARGIN_MS) return -1;
    if (reason === 'changed' && this.prePaintSignature !== -1 && !reused) {
      this.reusedBaseline = true;
      return this.prePaintSignature;
    }
    return stageSignature(this.host.stage);
  }

  private decide(): RenderTickResult {
    if ((this.paintMode() ?? 'live') !== 'reactive') return { painted: true, reason: 'live' };
    if (renderHoldActive()) return { painted: true, reason: 'hold' };
    if (now() - this.lastPaintMs >= IDLE_FLOOR_MS) return { painted: true, reason: 'floor' };
    const sig = stageSignature(this.host.stage);
    if (sig !== this.lastSignature) {
      this.prePaintSignature = lastWalkRenderMutates() ? -1 : sig;
      return { painted: true, reason: 'changed' };
    }
    return { painted: false, reason: 'skipped' };
  }
}
