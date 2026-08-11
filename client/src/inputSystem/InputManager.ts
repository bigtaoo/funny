/**
 * InputManager — platform-agnostic pointer input in DESIGN SPACE.
 *
 * Platform adapters (WebAdapter, WechatAdapter) convert raw pointer/touch events
 * to design-space coordinates and call _emitDown / _emitMove / _emitUp.
 *
 * Game code subscribes via onDown / onMove / onUp.
 * Each subscribe call returns an unsubscribe function — call it in destroy().
 */

import { netLog } from '../net/log';

const log = netLog('input');

type Handler = (x: number, y: number) => void;
type WheelHandler = (x: number, y: number, deltaY: number) => void;
type Unsub   = () => void;

export class InputManager {
  private downs: Handler[] = [];
  private moves: Handler[] = [];
  private ups:   Handler[] = [];
  private wheels: WheelHandler[] = [];
  /** Cap on contained-error logs so a handler that throws on every pointer-move can't flood the ring buffer. */
  private errLogged = 0;
  /**
   * While true, every emitted pointer event is dropped before dispatch. The SceneManager raises
   * this for the duration of a scene-switch fade: input here bypasses PixiJS entirely (WebAdapter
   * feeds us straight from DOM pointer listeners), so the fade's paper-tint cover cannot block taps
   * on its own. Without this gate, a tap during the ~270ms fade reaches BOTH the outgoing scene (still
   * mounted + subscribed until the swap) and the already-constructed incoming scene, firing stale
   * hit-rects and navigating somewhere the user never tapped. Only the handful of transitions the
   * SceneManager fades (enter/exit match, enter/exit SLG) engage this gate at all — every instant
   * (non-fade) goto leaves input live throughout.
   */
  private suppressed = false;
  /**
   * Fires on a pointer-DOWN that arrives while suppressed. The SceneManager uses it to abort the
   * fade on the first tap (skip straight to the target scene) so a hurried second tap isn't lost to
   * the 270ms freeze. The down that triggers it is still consumed (never dispatched).
   */
  private suppressedDownHook: (() => void) | null = null;
  /** One-shot: eat the next pointer-UP without dispatching. Used to swallow the release of a fade-aborting tap. */
  private swallowUp = false;
  /**
   * Number of stage-level modal dialogs currently mounted (AppealDialog / FeedbackDialog — app.ts
   * mounts them on `app.stage`, outside SceneManager, on top of a scene that stays live and
   * subscribed underneath). While > 0 nothing is dispatched to subscribers at all.
   *
   * Those dialogs are pure PixiJS-event consumers (`eventMode`/`pointertap` on their own display
   * objects), so this gate never touches their own buttons — it only stops the SCENE underneath
   * from seeing the same tap. Without it, a tap on the dialog's own controls landed on the Lobby's
   * hit-rects at the same screen position as well: the input field sat on the big Start button, the
   * Submit button on the campaign pillar and Close on the world pillar (2026-08-10 bug report — the
   * dialog's Close button "returned" to the SLG map / campaign instead of the Lobby). Making the
   * dialogs' own `dim` backdrop swallow taps (2026-08-09) could not fix that: pointer input bypasses
   * PixiJS entirely here (WebAdapter feeds us straight from DOM listeners), so no display object,
   * however hit-testable, can block it — the gate has to live at the source, same as `suppressed`.
   *
   * A count, not a boolean: an appeal prompt can pop over an already-open feedback dialog, and the
   * gate must survive the first of the two closing. Kept separate from `suppressed` so the fade gate
   * and the modal gate can never clear each other.
   */
  private modals = 0;

  /** Gate all pointer dispatch on/off (see {@link suppressed}). Called by the SceneManager around fades. */
  suppress(on: boolean): void { this.suppressed = on; }

  /** Raise (`true`) / lower (`false`) the modal gate around a stage-level dialog (see {@link modals}). */
  holdForModal(on: boolean): void { this.modals = Math.max(0, this.modals + (on ? 1 : -1)); }

  /** Register (or clear) the fade-abort hook fired on a suppressed pointer-down (see {@link suppressedDownHook}). */
  onSuppressedInput(fn: (() => void) | null): void { this.suppressedDownHook = fn; }

  /** Drop the next pointer-up without dispatching — so a fade-aborting tap can't also activate the new scene. */
  swallowNextUp(): void { this.swallowUp = true; }

  onDown(fn: Handler): Unsub {
    this.downs.push(fn);
    return () => { this.downs = this.downs.filter(f => f !== fn); };
  }

  onMove(fn: Handler): Unsub {
    this.moves.push(fn);
    return () => { this.moves = this.moves.filter(f => f !== fn); };
  }

  onUp(fn: Handler): Unsub {
    this.ups.push(fn);
    return () => { this.ups = this.ups.filter(f => f !== fn); };
  }

  /** Mouse-wheel scroll (browser only — no WeChat equivalent; touch/drag covers that platform). */
  onWheel(fn: WheelHandler): Unsub {
    this.wheels.push(fn);
    return () => { this.wheels = this.wheels.filter(f => f !== fn); };
  }

  /**
   * Dispatch a pointer event to every subscriber. Iterates a SNAPSHOT (a handler
   * may unsubscribe mid-dispatch) and isolates each handler in a try/catch: one
   * throwing handler (e.g. a stale subscription touching a display object destroyed
   * during a scene switch) must NOT skip the remaining handlers — otherwise the
   * live scene's handler never runs and the whole app appears dead to taps.
   */
  private dispatch(list: Handler[], x: number, y: number): void {
    for (const f of list.slice()) {
      try {
        f(x, y);
      } catch (e) {
        if (this.errLogged < 8) {
          this.errLogged++;
          log.error('input handler threw (contained)', e instanceof Error ? (e.stack ?? e.message) : String(e));
        }
      }
    }
  }

  // ── Called by platform adapters ───────────────────────────────────────────
  _emitDown(x: number, y: number): void {
    // Modal open (see `modals`): the scene underneath is covered and must not see this tap at all.
    // Checked before the fade gate — a modal is not a transition, so there is nothing to abort.
    if (this.modals > 0) return;
    // A down during a fade aborts it (via the hook) and is consumed — never delivered to a scene.
    if (this.suppressed) { this.suppressedDownHook?.(); return; }
    this.dispatch(this.downs, x, y);
  }
  _emitMove(x: number, y: number): void {
    if (this.modals > 0 || this.suppressed) return;
    this.dispatch(this.moves, x, y);
  }
  _emitUp(x: number, y: number): void {
    if (this.modals > 0 || this.suppressed) return;
    // The hook may have lifted suppression mid-gesture; still swallow this release so the
    // fade-aborting tap doesn't land on the freshly-mounted scene as a real tap.
    if (this.swallowUp) { this.swallowUp = false; return; }
    this.dispatch(this.ups, x, y);
  }
  _emitWheel(x: number, y: number, deltaY: number): void {
    if (this.modals > 0 || this.suppressed) return;
    for (const f of this.wheels.slice()) {
      try {
        f(x, y, deltaY);
      } catch (e) {
        if (this.errLogged < 8) {
          this.errLogged++;
          log.error('wheel handler threw (contained)', e instanceof Error ? (e.stack ?? e.message) : String(e));
        }
      }
    }
  }
}
