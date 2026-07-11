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
type Unsub   = () => void;

export class InputManager {
  private downs: Handler[] = [];
  private moves: Handler[] = [];
  private ups:   Handler[] = [];
  /** Cap on contained-error logs so a handler that throws on every pointer-move can't flood the ring buffer. */
  private errLogged = 0;
  /**
   * While true, every emitted pointer event is dropped before dispatch. The SceneManager raises
   * this for the duration of a scene-switch fade: input here bypasses PixiJS entirely (WebAdapter
   * feeds us straight from DOM pointer listeners), so the fade's black cover cannot block taps on
   * its own. Without this gate, a tap during the ~280ms fade reaches BOTH the outgoing scene (still
   * mounted + subscribed until the swap) and the already-constructed incoming scene, firing stale
   * hit-rects and navigating somewhere the user never tapped.
   */
  private suppressed = false;
  /**
   * Fires on a pointer-DOWN that arrives while suppressed. The SceneManager uses it to abort the
   * fade on the first tap (skip straight to the target scene) so a hurried second tap isn't lost to
   * the 280ms freeze. The down that triggers it is still consumed (never dispatched).
   */
  private suppressedDownHook: (() => void) | null = null;
  /** One-shot: eat the next pointer-UP without dispatching. Used to swallow the release of a fade-aborting tap. */
  private swallowUp = false;

  /** Gate all pointer dispatch on/off (see {@link suppressed}). Called by the SceneManager around fades. */
  suppress(on: boolean): void { this.suppressed = on; }

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
    // A down during a fade aborts it (via the hook) and is consumed — never delivered to a scene.
    if (this.suppressed) { this.suppressedDownHook?.(); return; }
    this.dispatch(this.downs, x, y);
  }
  _emitMove(x: number, y: number): void {
    if (this.suppressed) return;
    this.dispatch(this.moves, x, y);
  }
  _emitUp(x: number, y: number): void {
    if (this.suppressed) return;
    // The hook may have lifted suppression mid-gesture; still swallow this release so the
    // fade-aborting tap doesn't land on the freshly-mounted scene as a real tap.
    if (this.swallowUp) { this.swallowUp = false; return; }
    this.dispatch(this.ups, x, y);
  }
}
