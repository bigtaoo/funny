// Coverage for the tap-vs-drag disambiguation used by the Hero Roster (CardScene) and Equipment bag
// (EquipmentScene) grids (2026-07-17). Firing a cell's hit action on pointer-DOWN made a drag that
// started on a cell instantly open its detail instead of scrolling; ScrollTapGesture defers the action
// to pointer-up and drops it once the pointer crosses the drag threshold.
import { describe, it, expect, vi } from 'vitest';
import { ScrollTapGesture, DRAG_THRESHOLD } from '../src/ui/scrollTapGesture';

describe('ScrollTapGesture', () => {
  it('fires the captured tap on up when the pointer never moves (pure tap → open detail)', () => {
    const g = new ScrollTapGesture();
    const tap = vi.fn();
    g.down(0, 100, tap);
    const fired = g.up();
    expect(fired).toBe(tap);
    fired?.();
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('fires the tap when movement stays within the drag threshold (small jitter is still a tap)', () => {
    const g = new ScrollTapGesture();
    const tap = vi.fn();
    g.down(0, 100, tap);
    expect(g.move(100 + DRAG_THRESHOLD)).toBeNull(); // exactly at threshold → not yet a drag
    expect(g.up()).toBe(tap);
  });

  it('drops the tap once the pointer drags past the threshold (drag on a cell → scroll, no detail)', () => {
    const g = new ScrollTapGesture();
    const tap = vi.fn();
    g.down(0, 100, tap);
    // Drag up by more than the threshold → scroll delta returned, tap dropped.
    expect(g.move(100 - (DRAG_THRESHOLD + 1))).toBe(DRAG_THRESHOLD + 1);
    expect(g.up()).toBeNull();
    expect(tap).not.toHaveBeenCalled();
  });

  it('keeps reporting scroll on every move after the threshold is crossed, even if it dips back inside', () => {
    const g = new ScrollTapGesture();
    g.down(50, 200, vi.fn());
    expect(g.move(200 - 10)).toBe(60); // dragged up 10 from scroll 50 → 50 + 10
    // Latched as a drag: a subsequent small move (within threshold of the down point) still scrolls.
    expect(g.move(200 - 2)).toBe(52);
    expect(g.up()).toBeNull();
  });

  it('clamps scrollY at 0 when dragging downward past the top', () => {
    const g = new ScrollTapGesture();
    g.down(5, 100, null);
    // Drag down (y increases) by more than the current scroll → would go negative, clamped to 0.
    expect(g.move(100 + 20)).toBe(0);
  });

  it('scrolls with no tap action when the down landed on empty space', () => {
    const g = new ScrollTapGesture();
    g.down(0, 100, null);
    expect(g.move(100 - 30)).toBe(30);
    expect(g.up()).toBeNull(); // nothing to fire
  });

  it('reports active only between down and up', () => {
    const g = new ScrollTapGesture();
    expect(g.active).toBe(false);
    g.down(0, 0, vi.fn());
    expect(g.active).toBe(true);
    g.up();
    expect(g.active).toBe(false);
  });

  it('ignores move() with no gesture in progress', () => {
    const g = new ScrollTapGesture();
    expect(g.move(100)).toBeNull();
  });

  it('resets state on up so the next gesture starts clean (a drag then a tap)', () => {
    const g = new ScrollTapGesture();
    const drag = vi.fn();
    g.down(0, 100, drag);
    g.move(100 - 50);
    expect(g.up()).toBeNull();
    expect(drag).not.toHaveBeenCalled();

    // Fresh gesture: a clean tap must fire, unaffected by the previous drag's latched state.
    const tap = vi.fn();
    g.down(0, 300, tap);
    expect(g.up()).toBe(tap);
  });
});
