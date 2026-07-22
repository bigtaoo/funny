import * as PIXI from 'pixi.js-legacy';
import { netLog } from '../net/log';
import { setActiveScene, recordFrameSample } from '../net/anomaly';

const log = netLog('scene');

// ── Base scene interface ───────────────────────────────────────────────────────

export interface Scene {
  readonly container: PIXI.Container;
  update(dt: number): void;
  destroy(): void;
  /**
   * Optional: suspend/resume pointer-input subscriptions (not the scene itself) while an overlay
   * sits on top via {@link SceneManager.pushOverlay}. Implement this if the scene subscribes to
   * InputManager — otherwise a tap meant for the overlay also dispatches into this hidden scene's
   * handlers underneath (InputManager broadcasts to every subscriber regardless of z-order). Scenes
   * that never expect an overlay above them (most of them) can leave both unimplemented.
   */
  pause?(): void;
  resume?(): void;
}

// ── Transition tuning ──────────────────────────────────────────────────────────

/**
 * Paper-tint cover color + peak alpha (translucent, not opaque black) — matches the
 * notebook-paper look (`sketchUi.ts` C.paper) instead of a jarring hard cut to black.
 */
const OVERLAY_COLOR = 0xfaf6ee;
const OVERLAY_PEAK_ALPHA = 0.92;
/** Fade-to-cover (hide the outgoing scene). Fast — the cover appearing is the less noticeable half. */
const FADE_OUT_MS = 90;
/** Fade-from-cover (reveal the incoming scene). Slower so the reveal reads as settling in. */
const FADE_IN_MS = 180;

/** Options for a single {@link SceneManager.goto} call. */
export interface GotoOptions {
  /**
   * Cross-fade through the paper-tint cover instead of swapping in the same frame. Reserved for
   * the handful of top-level transitions where the screen genuinely changes "world" (entering/
   * exiting a match, entering/exiting the SLG world map) — every other navigation (lobby tabs,
   * sub-screens, back buttons) swaps instantly. Defaults to false.
   */
  fade?: boolean;
}

/**
 * The slice of InputManager the SceneManager needs to freeze pointer input during a fade.
 * Taps bypass PixiJS (fed straight from DOM listeners), so the fade's paper-tint cover can't
 * block them — the manager must gate the input source directly, or a tap mid-fade reaches the
 * still-live hit-rects of the outgoing (and pre-constructed incoming) scene and navigates unexpectedly.
 */
export interface InputGate {
  suppress(on: boolean): void;
  /** Register a hook fired on a pointer-down received while suppressed (used to abort the fade on tap). */
  onSuppressedInput(fn: (() => void) | null): void;
  /** Drop the next pointer-up without dispatching (swallow the release of the fade-aborting tap). */
  swallowNextUp(): void;
}

/** easeInOutQuad — cheap, dependency-free; symmetric acceleration/deceleration. */
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

// ── SceneManager ───────────────────────────────────────────────────────────────

/**
 * Manages the active scene.  Scenes are added to `targetStage` (defaults to
 * `app.stage`).  Pass `ScalingManager.gameLayer` as `targetStage` so that all
 * scene content goes through the Contain-scaled game layer.
 *
 * Most scene switches swap in the same frame (no fade) — that's the default. Passing
 * `{ fade: true }` cross-fades through a full-screen paper-tint cover instead
 * (fade-out → swap → fade-in). Either way this never keeps two scenes mounted at once, so
 * the outgoing scene is still destroyed promptly and no scene pays a double
 * construct/render cost mid-transition.
 */
export class SceneManager {
  private current: Scene | null = null;
  private readonly targetStage: PIXI.Container;
  /** Set once the current scene's update() has thrown, so we log the fault once instead of every frame. */
  private updateFaulted = false;
  /**
   * A scene mounted on top of `current` without destroying it (see {@link pushOverlay}). Unlike the
   * fade transition below, this is a deliberate exception to the "never two scenes mounted" rule —
   * used for panels (CityScene's Home Desk) that must open/close with the SLG map alive underneath,
   * no teardown+rebuild. Only one slot: nothing today nests a second overlay on top of this one.
   */
  private overlayScene: Scene | null = null;

  /** Full-screen paper-tint cover, attached to `app.stage` (screen pixels) only while a fade is running. */
  private overlay: PIXI.Graphics | null = null;
  /**
   * Active fade, or null when idle.
   * - phase 'out': `current` is still the OUTGOING scene; `incoming` is constructed but NOT mounted.
   * - phase 'in':  the swap has happened, `current === incoming` and is mounted.
   */
  private transition: { phase: 'out' | 'in'; elapsedMs: number; incoming: Scene } | null = null;
  /** A goto() that arrived mid-fade, replayed once the current fade settles. Only the latest is kept. */
  private queued: Scene | null = null;

  constructor(
    private readonly app: PIXI.Application,
    targetStage?: PIXI.Container,
    /** Pointer-input source frozen for the duration of each fade (see {@link InputGate}). */
    private readonly inputGate?: InputGate,
  ) {
    this.targetStage = targetStage ?? app.stage;
    app.ticker.add(this.onTick, this);
    // First tap during a fade skips it (see skipTransition) rather than being swallowed for the full ~270ms.
    this.inputGate?.onSuppressedInput(() => this.skipTransition());
  }

  goto(scene: Scene, opts?: GotoOptions): void {
    // A hard scene swap always means "done with this whole area" — drop any overlay riding on top
    // of `current` first so it doesn't linger as an orphaned child on top of the new scene.
    if (this.overlayScene) {
      this.targetStage.removeChild(this.overlayScene.container);
      this.destroyScene(this.overlayScene);
      this.overlayScene = null;
    }

    // Default (no fade requested), or cold start (nothing to cross-fade from): swap in the same
    // frame. An instant goto also wins over any fade already in flight — it cancels it outright
    // rather than queuing another cross-fade.
    if (!opts?.fade || (!this.current && !this.transition)) {
      this.cancelTransition();
      this.swap(scene);
      this.hideOverlay();
      this.inputGate?.suppress(false); // no fade in flight → input live
      return;
    }

    if (this.transition) {
      if (this.transition.phase === 'out') {
        // Still fading the old scene out; the target hasn't mounted yet. Just retarget —
        // the never-mounted incoming can be dropped without touching the display list.
        this.destroyScene(this.transition.incoming);
        this.transition.incoming = scene;
      } else {
        // Already fading the new scene in — let it finish, then fade straight back out to `scene`.
        if (this.queued) this.destroyScene(this.queued); // keep only the latest request
        this.queued = scene;
      }
      return;
    }

    this.startTransition(scene);
  }

  get screenWidth():  number { return this.app.screen.width;  }
  get screenHeight(): number { return this.app.screen.height; }

  private startTransition(incoming: Scene): void {
    this.transition = { phase: 'out', elapsedMs: 0, incoming };
    this.showOverlay(); // starts at alpha 0
    this.inputGate?.suppress(true); // freeze taps until the fade settles — the cover can't (input bypasses Pixi)
  }

  /**
   * Abort an in-flight fade on the first tap: jump straight to the final target scene with no more
   * fading, and swallow the tap's release so it doesn't register on the freshly-mounted scene. Keeps
   * navigation snappy under fast tapping without reintroducing the mis-navigation the freeze prevents.
   */
  private skipTransition(): void {
    const tr = this.transition;
    if (!tr) return;
    // 'out' hasn't mounted the target yet; 'in' already has. A queued request (arrived mid-fade) wins.
    const target = this.queued ?? (tr.phase === 'out' ? tr.incoming : null);
    this.queued = null;
    // In 'out' the incoming was constructed but never mounted; if a queued request supersedes it,
    // dispose it here (swap only tears down the *current* scene, which is still the outgoing one).
    if (tr.phase === 'out' && target !== tr.incoming) this.destroyScene(tr.incoming);
    if (target) this.swap(target); // destroys the outgoing (or the mounted incoming, if superseded by queued)
    this.transition = null;
    this.hideOverlay();
    this.inputGate?.suppress(false);
    this.inputGate?.swallowNextUp(); // eat the release of the aborting tap
  }

  /** Detach + destroy the current scene (if any) and mount `next`. Shared by instant and mid-fade swaps. */
  private swap(next: Scene): void {
    if (this.current) {
      const prev = this.current;
      // Detach first, then destroy — a throwing destroy() must not leave the
      // outgoing scene mounted, and must not abort switching to the new scene.
      this.targetStage.removeChild(prev.container);
      this.destroyScene(prev);
    }
    this.current = next;
    this.updateFaulted = false;
    this.targetStage.addChild(next.container);
    // Stamp the scene name for anomaly attribution (ANR watchdog has no other lead on what was on screen).
    setActiveScene(next.constructor?.name ?? 'Scene');
  }

  /**
   * Mount `scene` on top of `current` instead of replacing it — `current` stays alive, mounted,
   * and ticking underneath (so e.g. SLG marches keep animating), just no longer receiving pointer
   * input (see {@link Scene.pause}) and visually covered by the overlay. Use {@link popOverlay} to
   * reverse it. Not fade-aware: only call this from a settled (non-transitioning) state.
   */
  pushOverlay(scene: Scene): void {
    // A caller replacing one overlay with a sibling (e.g. DefenseEditorScene's onBack rebuilding the
    // City overlay it was opened over) lands here with `overlayScene` still set — detach before destroy,
    // same as swap()/popOverlay(), or the destroyed container lingers in the display list and the new
    // overlay's first render throws walking into it (frozen on the last good frame, screen never advances).
    if (this.overlayScene) {
      this.targetStage.removeChild(this.overlayScene.container);
      this.destroyScene(this.overlayScene);
    }
    this.overlayScene = scene;
    this.current?.pause?.();
    this.targetStage.addChild(scene.container); // addChild appends last → renders on top of `current`
    setActiveScene(scene.constructor?.name ?? 'Scene');
  }

  /** Tear down the overlay scene mounted by {@link pushOverlay} and resume `current` underneath. */
  popOverlay(): void {
    const ov = this.overlayScene;
    if (!ov) return;
    this.overlayScene = null;
    this.targetStage.removeChild(ov.container);
    this.destroyScene(ov);
    this.current?.resume?.();
    setActiveScene(this.current?.constructor?.name ?? 'Scene');
  }

  private destroyScene(scene: Scene): void {
    try {
      scene.destroy();
    } catch (e) {
      log.error('scene destroy threw (contained)', errInfo(e));
    }
  }

  /** Abandon any in-flight fade, ensuring its incoming scene is disposed (used before an instant swap). */
  private cancelTransition(): void {
    if (this.transition) {
      // In 'out' the incoming was never mounted; in 'in' it is already `current` and must survive.
      if (this.transition.phase === 'out') this.destroyScene(this.transition.incoming);
      this.transition = null;
    }
    if (this.queued) { this.destroyScene(this.queued); this.queued = null; }
  }

  /** Create/resize the paper-tint cover and put it on top of `app.stage` at alpha 0. */
  private showOverlay(): void {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    if (!this.overlay) {
      this.overlay = new PIXI.Graphics();
      this.overlay.eventMode = 'static'; // swallow taps so nothing is clickable mid-fade
    }
    this.overlay.clear();
    this.overlay.beginFill(OVERLAY_COLOR).drawRect(0, 0, w, h).endFill();
    this.overlay.hitArea = new PIXI.Rectangle(0, 0, w, h);
    this.overlay.alpha = 0;
    this.app.stage.addChild(this.overlay); // addChild re-parents to the top each time
  }

  private hideOverlay(): void {
    if (this.overlay?.parent) this.overlay.parent.removeChild(this.overlay);
  }

  private onTick = (): void => {
    this.stepTransition(this.app.ticker.deltaMS);

    if (this.current) this.tickScene(this.current);
    // The overlay scene (if any) ticks too, right on top of `current` — it's the visible/interactive
    // one, `current` just keeps simulating (paused only on input) underneath it.
    if (this.overlayScene) this.tickScene(this.overlayScene);
  };

  // Timed (not just try/caught): a single scene.update() call running for seconds is one of the
  // two things that can produce an ANR-watchdog report, and this is the only vantage point that can
  // tell the difference — see recordFrameSample in net/anomaly for why that distinction matters.
  private tickScene(scene: Scene): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      scene.update(this.app.ticker.deltaMS / 1000);
    } catch (e) {
      // CRITICAL: this runs on app.ticker, ahead of PIXI's renderer listener. In
      // PIXI 7 a throw from any ticker listener aborts the update loop AND prevents
      // the next requestAnimationFrame from being scheduled — the whole canvas
      // freezes permanently until a page reload (the "UI switch freezes, only a reload recovers" report).
      // Contain it so the renderer still paints and the app stays interactive; the
      // player can navigate away (goto resets the flag). Log once per scene so a
      // per-frame re-throw doesn't flood the client-log ring buffer.
      if (!this.updateFaulted) {
        this.updateFaulted = true;
        log.error('scene update threw (contained)', errInfo(e));
      }
    } finally {
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      recordFrameSample(t1 - t0);
    }
  }

  /** Advance the fade one frame. Fully contained: a throw here must never freeze the ticker. */
  private stepTransition(deltaMs: number): void {
    const tr = this.transition;
    if (!tr || !this.overlay) return;
    try {
      tr.elapsedMs += deltaMs;
      if (tr.phase === 'out') {
        const t = Math.min(1, tr.elapsedMs / FADE_OUT_MS);
        this.overlay.alpha = OVERLAY_PEAK_ALPHA * easeInOutQuad(t);
        if (t >= 1) {
          // At peak cover — safe to tear down the old scene and mount the new one unseen.
          this.swap(tr.incoming);
          tr.phase = 'in';
          tr.elapsedMs = 0;
          this.overlay.alpha = OVERLAY_PEAK_ALPHA;
        }
      } else {
        const t = Math.min(1, tr.elapsedMs / FADE_IN_MS);
        this.overlay.alpha = OVERLAY_PEAK_ALPHA * (1 - easeInOutQuad(t));
        if (t >= 1) {
          this.overlay.alpha = 0;
          this.transition = null;
          this.hideOverlay();
          // Replay the most recent request that arrived mid-fade; otherwise the fade is fully
          // settled, so let taps through again. startTransition re-freezes if we chain into a queue.
          if (this.queued) { const q = this.queued; this.queued = null; this.startTransition(q); }
          else this.inputGate?.suppress(false);
        }
      }
    } catch (e) {
      // Never let the fade math strand the app. Force a clean, mounted state.
      log.error('scene transition threw (contained)', errInfo(e));
      if (this.transition?.phase === 'out') this.swap(this.transition.incoming);
      this.transition = null;
      this.hideOverlay();
      this.inputGate?.suppress(false); // don't leave input frozen after a contained fault
    }
  }
}

/** Best-effort error detail (stack when available) for the client-log ring buffer. */
function errInfo(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}
