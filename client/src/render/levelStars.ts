// Reusable "enhancement/upgrade level as gold stars" widgets. Equipment (+N), character cards (Lv.N),
// and now auction listings (see AuctionScene) all show a level as a row of filled stars rather than a
// bare number — this module is the single place that draws it, so every caller shrinks/spaces/colors
// the row identically instead of re-deriving the same loop (2026-08-08: the auction house was still
// showing text "+3" while every other item view had already moved to stars).
//
// Two flavors:
//  - buildLevelStars: a real row of gold star icons (PIXI), for standalone item cards with room to spare.
//  - levelStarsText: plain '★'.repeat() text, for labels embedded in a translated sentence / cramped
//    text field with no room for a separate icon row (mirrors the old EquipmentScene.itemLabel convention).
import * as PIXI from 'pixi.js-legacy';
import { buildIcon } from './icons';
import { ui as C } from './sketchUi';

export interface LevelStars {
  container: PIXI.Container;
  /** Individual star icons, in level order — callers that animate a maxed row (see EquipmentScene's
   *  flipStars sweep) hang their own per-star state off these. */
  stars: PIXI.DisplayObject[];
}

/**
 * Row of `count` gold star icons, scaled down to fit `maxW` when it would otherwise overflow. Callers
 * own their own level→count clamping (max level differs by item type) — this just draws and fits the row.
 */
export function buildLevelStars(count: number, maxW: number, size = 14, gap = 3, color = C.gold): LevelStars {
  const container = new PIXI.Container();
  const stars: PIXI.DisplayObject[] = [];
  const n = Math.max(0, count);
  for (let i = 0; i < n; i++) {
    const st = buildIcon('star', size, color);
    // Pivot to the icon's own center (not top-left) so a caller that animates scale.x (e.g. a maxed-row
    // flip sweep) flips in place instead of sliding.
    st.pivot.set(size / 2, size / 2);
    st.x = i * (size + gap) + size / 2;
    st.y = size / 2;
    container.addChild(st);
    stars.push(st);
  }
  const starsW = n * size + Math.max(0, n - 1) * gap;
  if (starsW > maxW && starsW > 0) container.scale.set(Math.max(0.01, maxW / starsW));
  return { container, stars };
}

/** Plain-text star row (e.g. "★★★"), capped at `maxLevel` — for labels embedded in a translated
 *  sentence or a cramped text field where a separate icon row has no room. Empty string at level 0. */
export function levelStarsText(level: number, maxLevel: number): string {
  return level > 0 ? '★'.repeat(Math.max(0, Math.min(maxLevel, level))) : '';
}
