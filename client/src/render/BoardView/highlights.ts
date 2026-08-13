// BoardView's placement-highlight drawing (unit lane/building slot/meteor/column previews) +
// laneRect (shared with BoardView/effects.ts's rockslide sweep), extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛"). All mutate `highlightLayer` in place
// (.clear()/.beginFill()/…) — never reassign it — so a plain readonly reference is enough, no host
// object needed at all.
import * as PIXI from 'pixi.js-legacy';
import { ATTACK_LANES, BOARD_COLS, BOARD_ROWS } from '@nw/engine/config';
import { Side } from '../../game';
import { ILayout, Rect } from '../../layout/ILayout';
import { fx } from '../theme';

/** State/highlight colors sourced from theme.fx (art-direction §3.3). */
const HIGHLIGHT_LANE     = fx.laneValid;     // valid attack lane
const HIGHLIGHT_BUILDING = fx.buildingValid; // valid building slot
const HIGHLIGHT_ALPHA    = 0.18;
const HIGHLIGHT_METEOR   = fx.meteor;        // meteor targeting

/**
 * Returns the screen-space rect for a single game-column lane.
 *
 * Portrait:  lane = vertical stripe (full board height, one column wide).
 * Landscape: lane = horizontal band (full board width, one column tall — because
 *            game cols map to screen Y in landscape).
 */
export function laneRect(layout: ILayout, gameCol: number): Rect {
  const r    = layout.boardRect;
  const cell = layout.cellSize;
  // The joiner (Side.Top) has both grid axes mirrored in gridToScreen, so the
  // lane band must mirror the col axis too — otherwise the highlight lands on the
  // mirror-opposite band from where units actually render (empty-cell red bug).
  const band = layout.localSide === Side.Bottom ? gameCol : (BOARD_COLS - 1 - gameCol);
  if (layout.orientation === 'portrait') {
    return { x: r.x + band * cell, y: r.y, w: cell, h: r.h };
  }
  // In landscape, game col → screen Y band
  return { x: r.x, y: r.y + band * cell, w: r.w, h: cell };
}

/**
 * Highlight unit lane columns with per-column state:
 * - blocked (spawn row occupied) → red
 * - hovered → brighter blue
 * - normal  → standard blue
 *
 * Works for both portrait (vertical stripes) and landscape (horizontal bands).
 */
export function showUnitLaneHighlights(
  layer: PIXI.Graphics, layout: ILayout,
  lanes: number[],
  blockedCols: Set<number>,
  hoveredCol: number,
): void {
  layer.clear();
  for (const col of lanes) {
    const isBlocked = blockedCols.has(col);
    const isHovered = col === hoveredCol;
    const color = isBlocked ? fx.laneBlocked : (isHovered ? fx.laneHover : HIGHLIGHT_LANE);
    const alpha = isBlocked ? 0.28 : (isHovered ? 0.30 : HIGHLIGHT_ALPHA);

    layer.beginFill(color, alpha);
    const r = laneRect(layout, col);
    layer.drawRect(r.x, r.y, r.w, r.h);
    layer.endFill();
  }
}

export function showBuildingHighlights(layer: PIXI.Graphics, layout: ILayout, validCols: number[], buildingRow: number): void {
  layer.clear();
  for (const col of validCols) {
    const pos = layout.gridToScreen(col, buildingRow);
    const cs  = layout.cellSize;
    layer.beginFill(HIGHLIGHT_BUILDING, HIGHLIGHT_ALPHA);
    layer.drawRect(pos.x - cs / 2, pos.y - cs / 2, cs, cs);
    layer.endFill();
  }
}

/**
 * Show a 2×2 meteor target preview centered at (col, row) in game coords.
 * Draws a subtle full-board red tint + a bright 2×2 area.
 * Out-of-bounds cells are silently skipped.
 */
export function showMeteorTargetHighlight(layer: PIXI.Graphics, layout: ILayout, col: number, row: number): void {
  layer.clear();

  // Subtle full-board tint so the player knows meteor is selected
  const r = layout.boardRect;
  layer.beginFill(HIGHLIGHT_METEOR, 0.06);
  layer.drawRect(r.x, r.y, r.w, r.h);
  layer.endFill();

  // Bright 2×2 target area
  const cs = layout.cellSize;
  for (let dc = 0; dc <= 1; dc++) {
    for (let dr = 0; dr <= 1; dr++) {
      const tc = col + dc;
      const tr = row + dr;
      if (tc < 0 || tc >= BOARD_COLS) continue;
      if (tr < 0 || tr >= BOARD_ROWS)  continue;
      const pos = layout.gridToScreen(tc, tr);
      layer.lineStyle(2, HIGHLIGHT_METEOR, 0.9);
      layer.beginFill(HIGHLIGHT_METEOR, 0.40);
      layer.drawRect(pos.x - cs / 2, pos.y - cs / 2, cs, cs);
      layer.endFill();
    }
  }
}

/**
 * Highlight a single full column, used by column-targeted spells (rockslide, bridge_collapse).
 */
export function showColumnTargetHighlight(layer: PIXI.Graphics, layout: ILayout, col: number): void {
  layer.clear();
  if (col < 0 || col >= BOARD_COLS) return;
  const r = laneRect(layout, col);
  layer.beginFill(HIGHLIGHT_METEOR, 0.30);
  layer.lineStyle(2, HIGHLIGHT_METEOR, 0.9);
  layer.drawRect(r.x, r.y, r.w, r.h);
  layer.endFill();
}
