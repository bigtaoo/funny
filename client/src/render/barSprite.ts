/**
 * barSprite.ts — the little HP bars over units and buildings, as sprites instead of Graphics.
 *
 * These are plain axis-aligned rectangles, and there were two of them per unit and per building,
 * with the fill `clear()`ed and re-`drawRect()`ed on EVERY frame (the fill width tracks HP, so the
 * geometry genuinely changed) — measured 2026-09-22 at ~8 geometry rebuilds per frame in a mid-game
 * battle. The indices themselves are trivial (12 per bar), but each rebuilt `Graphics` is its own
 * batch break, and they sit between the unit sprites that would otherwise batch together.
 *
 * `PIXI.Texture.WHITE` costs nothing to stretch and nothing to recolour: `width` is a scale and
 * `tint` is a uniform, so an HP change is two number writes and no triangulation at all. Every bar
 * in the battle shares that one 1x1 baseTexture, so they also stop breaking each other's batches.
 *
 * Bars are anchored at (0, 0.5) horizontally-left / vertically-centred on the row they are given,
 * matching the `drawRect(-w/2, y, w * ratio, h)` the Graphics versions used: the fill grows
 * rightward from the bar's left edge, not outward from its centre.
 */
import * as PIXI from 'pixi.js-legacy';

/**
 * A solid bar of `w` x `h` whose left edge sits at `x` and whose top edge sits at `y`.
 *
 * `tint` carries the colour, so callers recolour by assignment (`s.tint = ...`) with no redraw.
 */
export function barSprite(x: number, y: number, w: number, h: number, color: number, alpha = 1): PIXI.Sprite {
  const s = new PIXI.Sprite(PIXI.Texture.WHITE);
  s.x = x;
  s.y = y;
  s.width  = w;
  s.height = h;
  s.tint   = color;
  s.alpha  = alpha;
  return s;
}

/**
 * Set a fill bar to `ratio` of `fullW`, in `color`.
 *
 * Deliberately does NOT touch `visible`: whether an HP bar is shown at all is owned by the caller
 * (units fade theirs in for a few seconds after a hit), while this runs every frame so the width is
 * already right at the moment it becomes visible. Writing `visible` here would fight that.
 */
export function setBarRatio(s: PIXI.Sprite, ratio: number, fullW: number, color: number): void {
  s.width = fullW * Math.max(0, Math.min(1, ratio));
  s.tint  = color;
}
