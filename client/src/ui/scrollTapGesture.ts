// Shared tap-vs-drag disambiguation for scrollable scenes (Hero Roster / Equipment bag, 2026-07-17).
//
// A scene's grid cell is both a tap target (open detail) and a drag surface (scroll the list). Firing
// the hit action on pointer-DOWN made a drag that started on a cell instantly open that cell's detail
// instead of scrolling. This helper defers the hit action to pointer-UP and fires it only when the
// pointer never crossed the drag threshold — otherwise the gesture is a scroll and the action is dropped.
//
// It owns only the gesture math (pending action + scroll delta). The scene keeps its own scrollY /
// dirty-flag / modal state and decides what a "hit action" is; this class stays pure and framework-free
// so it can be unit-tested without PIXI.

/** Pointer travel (px, along the scroll axis) beyond which a gesture is treated as a drag, not a tap. */
export const DRAG_THRESHOLD = 6;

export class ScrollTapGesture {
  private start: { y: number; scroll: number } | null = null;
  private pendingTap: (() => void) | null = null;
  private moved = false;

  /** Whether a gesture is in progress (down seen, up not yet). Mirrors the old `dragStart != null` guard. */
  get active(): boolean {
    return this.start !== null;
  }

  /**
   * Begin a gesture at pointer-down. `tap` is the hit action captured at the down point (or null when
   * the down landed on empty space) — it will fire on up only if the gesture stays a tap.
   */
  down(scrollY: number, y: number, tap: (() => void) | null): void {
    this.start = { y, scroll: scrollY };
    this.pendingTap = tap;
    this.moved = false;
  }

  /**
   * Feed a pointer-move. Returns the new scrollY once the gesture has crossed the drag threshold
   * (and on every subsequent move), or null while it still counts as a tap / when no gesture is active.
   * Crossing the threshold latches `moved`, so the pending tap is dropped on up.
   */
  move(y: number): number | null {
    if (!this.start) return null;
    const dy = y - this.start.y;
    if (this.moved || Math.abs(dy) > DRAG_THRESHOLD) {
      this.moved = true;
      return Math.max(0, this.start.scroll - dy);
    }
    return null;
  }

  /**
   * End the gesture. Returns the captured tap action to fire — only for a genuine tap (pointer never
   * dragged past the threshold), otherwise null (a released drag just settles the scroll). Resets state.
   */
  up(): (() => void) | null {
    const tap = this.moved ? null : this.pendingTap;
    this.start = null;
    this.pendingTap = null;
    this.moved = false;
    return tap;
  }
}
