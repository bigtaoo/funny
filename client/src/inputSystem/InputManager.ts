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
  _emitDown(x: number, y: number): void { this.dispatch(this.downs, x, y); }
  _emitMove(x: number, y: number): void { this.dispatch(this.moves, x, y); }
  _emitUp(x: number, y: number): void   { this.dispatch(this.ups, x, y); }
}
