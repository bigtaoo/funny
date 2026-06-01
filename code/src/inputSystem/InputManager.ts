/**
 * InputManager — platform-agnostic pointer input in DESIGN SPACE.
 *
 * Platform adapters (WebAdapter, WechatAdapter) convert raw pointer/touch events
 * to design-space coordinates and call _emitDown / _emitMove / _emitUp.
 *
 * Game code subscribes via onDown / onMove / onUp.
 * Each subscribe call returns an unsubscribe function — call it in destroy().
 */

type Handler = (x: number, y: number) => void;
type Unsub   = () => void;

export class InputManager {
  private downs: Handler[] = [];
  private moves: Handler[] = [];
  private ups:   Handler[] = [];

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

  // ── Called by platform adapters ───────────────────────────────────────────
  _emitDown(x: number, y: number): void { this.downs.forEach(f => f(x, y)); }
  _emitMove(x: number, y: number): void { this.moves.forEach(f => f(x, y)); }
  _emitUp(x: number, y: number): void   { this.ups.forEach(f => f(x, y)); }
}
