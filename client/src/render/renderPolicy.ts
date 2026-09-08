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
 * 2. `ticker.maxFPS = `{@link TARGET_FPS} — one assignment, halves the frame count on every
 *    120 Hz device. `dt` is unaffected in kind (every consumer already integrates `deltaMS`),
 *    only its distribution changes, so no simulation reads differently.
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
import { setLiveRenderStats, type RenderStats } from './renderStats';

/**
 * Backbuffer resolution ceiling. 2 keeps text and ink crisp on every retina-class display;
 * above that the extra pixels are pure fill-rate cost (a dpr-3 phone rasterises 2.25× the area
 * of a dpr-2 one for the same picture).
 */
export const MAX_RENDER_RESOLUTION = 2;

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
}

/**
 * "Something changed that the signature cannot see" — paint the next tick. Used for the handful of
 * events that mutate the picture from outside the scene graph the policy walks (a renderer resize,
 * a scene swap).
 */
export function invalidateRender(): void {
  activeUntilMs = Math.max(activeUntilMs, now() + 1);
}

/** True while a {@link holdRenderActive} / {@link invalidateRender} hold is still in effect. */
export function renderHoldActive(): boolean {
  return now() < activeUntilMs;
}

/** Test seam: drop any outstanding activity hold. */
export function resetRenderHold(): void {
  activeUntilMs = 0;
}

// ── change detection ──────────────────────────────────────────────────────────

/** FNV-1a step. Kept inline-able and integer-only so the walk allocates nothing. */
function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 0x01000193) >>> 0;
}

function mixString(h: number, s: string): number {
  let out = h;
  for (let i = 0; i < s.length; i++) out = mix(out, s.charCodeAt(i));
  return mix(out, s.length);
}

/**
 * Every field of a display object the renderer's output depends on, folded into one number.
 *
 * What is deliberately read, and why each one is load-bearing:
 * - `visible` / `renderable` / `alpha` / `tint` — the cheap ways a scene shows and hides things.
 * - `transform._localID` — PIXI bumps this on any position/scale/rotation/skew/pivot write, so one
 *   integer covers every kind of movement. World transforms are NOT read: they are recomputed
 *   during render, which we may be skipping, and a parent's own `_localID` is already in the hash.
 * - `baseTexture.uid` + the frame rect + `baseTexture.dirtyId` — an atlas frame swap moves the
 *   frame; a different image moves the uid; an image finishing its decode (or a `Text`
 *   re-rasterising into its canvas) moves `dirtyId`. Without the last one, late art would pop in
 *   only on the next floor tick.
 * - `geometry.dirty` — `Graphics` bumps it on `clear()` and on every drawing op, which is how a
 *   re-stroked panel or a redrawn HUD announces itself.
 * - `text` — a label rewritten to the same width is otherwise invisible to every other field.
 * - `children.length` and recursion order — covers add/remove/reparent. `zIndex` is read as a value
 *   rather than via the container's `sortDirty` flag: sorting happens inside render, so between two
 *   paints the child array is still in the old order, and `sortDirty` can already be true from an
 *   unrelated `addChild` (which is exactly how the first version of this let a reorder through).
 *
 * A mask needs no field of its own: PIXI's `mask` setter flips the mask object's `renderable`, and
 * every mask in this codebase is a child of the tree it clips, so the change is already hashed.
 *
 * Every field above is pinned by a case in test/ui/renderPolicy.ui.ts that goes red when the line
 * is deleted, except `visible` and `children.length`: those two are implied by the walk's shape
 * (a hidden subtree is not descended into; an added child folds in more values) and are kept only
 * to stop the hash from being structurally ambiguous. Redundant fields were REMOVED rather than
 * left unpinned. Four were in the first version and none of them could be made to matter:
 * `graphicsData.length` (always moves with `geometry.dirty`), `sortDirty` (always moves with
 * `zIndex`), `baseTexture.valid` (PIXI derives it from the size, which moves `dirtyId`) and a
 * `mask` presence bit.
 */
export function stageSignature(root: PIXI.Container): number {
  let h = 0x811c9dc5;
  const visit = (o: PIXI.DisplayObject): void => {
    const d = o as PIXI.DisplayObject & {
      visible?: boolean; renderable?: boolean; alpha?: number; tint?: number;
      transform?: { _localID?: number };
      texture?: {
        baseTexture?: { uid?: number; dirtyId?: number };
        frame?: { x: number; y: number; width: number; height: number };
      };
      geometry?: { dirty?: number };
      text?: unknown;
      children?: PIXI.DisplayObject[];
      zIndex?: number;
    };
    h = mix(h, d.visible === false ? 1 : 2);
    if (d.visible === false) return;
    h = mix(h, d.renderable === false ? 3 : 4);
    h = mix(h, Math.round((d.alpha ?? 1) * 1024));
    h = mix(h, d.tint ?? 0);
    h = mix(h, d.transform?._localID ?? 0);
    h = mix(h, d.zIndex ?? 0);
    const tex = d.texture;
    if (tex) {
      // `baseTexture.uid` + the frame rect, NOT `texture.uid` — PIXI's `Texture` has no `uid` at
      // all (only `BaseTexture` does), so the first version of this line hashed `undefined` on
      // every sprite in the tree and an atlas frame swap went undetected. Caught by the mutation
      // sweep in test/ui/renderPolicy.ui.ts: deleting the line changed nothing.
      h = mix(h, tex.baseTexture?.uid ?? 0);
      const f = tex.frame;
      if (f) h = mix(mix(mix(mix(h, f.x), f.y), f.width), f.height);
      h = mix(h, tex.baseTexture?.dirtyId ?? 0);
    }
    if (d.geometry) h = mix(h, d.geometry.dirty ?? 0);
    if (typeof d.text === 'string') h = mixString(h, d.text);
    const kids = d.children;
    if (kids) {
      h = mix(h, kids.length);
      for (let i = 0; i < kids.length; i++) visit(kids[i]!);
    }
  };
  visit(root);
  return h;
}

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
  private lastPaintMs = 0;
  /** Counters exposed for the browser measurement recipe (`window.__nwRenderStats`). */
  readonly stats: RenderStats = { ticks: 0, painted: 0, skipped: 0 };

  constructor(
    private readonly host: RenderLoopHost,
    /** Current scene's paint mode; `undefined` (no scene, or a scene that never declared one) = 'live'. */
    private readonly paintMode: () => PaintMode | undefined,
  ) {}

  install(): void {
    this.host.ticker.maxFPS = TARGET_FPS;
    setLiveRenderStats(this.stats);
    this.publishStats();
    // Cast: TickerPlugin's `render` is typed as a plain method, not as a TickerCallback.
    this.host.ticker.remove(this.host.render as PIXI.TickerCallback<unknown>, this.host);
    this.host.ticker.add(this.tick, this, PIXI.UPDATE_PRIORITY.LOW);
    this.lastPaintMs = now();
  }

  uninstall(): void {
    this.host.ticker.remove(this.tick, this);
    setLiveRenderStats(null);
  }

  /** One frame's decision. Exposed (not just wired to the ticker) so tests can step it by hand. */
  tick = (): RenderTickResult => {
    this.stats.ticks++;
    const result = this.decide();
    if (result.painted) {
      this.host.render();
      this.lastPaintMs = now();
      // Re-read AFTER painting: render itself mutates fields the signature reads (Text rasterises
      // into its texture and clears its dirty flag, containers sort their children), so a
      // pre-paint baseline would report a change on every following tick and never settle.
      this.lastSignature = stageSignature(this.host.stage);
      this.stats.painted++;
    } else {
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
  }

  private decide(): RenderTickResult {
    if ((this.paintMode() ?? 'live') !== 'reactive') return { painted: true, reason: 'live' };
    if (renderHoldActive()) return { painted: true, reason: 'hold' };
    if (now() - this.lastPaintMs >= IDLE_FLOOR_MS) return { painted: true, reason: 'floor' };
    const sig = stageSignature(this.host.stage);
    if (sig !== this.lastSignature) return { painted: true, reason: 'changed' };
    return { painted: false, reason: 'skipped' };
  }
}
