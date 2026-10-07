// Board geometry for TutorialDirector: enemy lookup, the meteor aim-assist anchor and beat target
// points — split out of TutorialDirector.ts for the 500-line rule (claudedocs/client-modules.md).
import { Side, type GameState } from '../../game';
import { BOARD_COLS, BOARD_ROWS, BOTTOM_BUILDING_ROW, BOTTOM_SPAWN_ROW } from '@nw/engine/config';
import type { ILayout } from '../../layout/ILayout';
import type { BeatSpec } from './beats';

/** Screen centre of a meteor's 2×2 footprint anchored at `a` (its top-left cell, SpellSystem.castMeteor). */
export function meteorAnchorCenter(layout: ILayout, a: { col: number; row: number }): { x: number; y: number } {
  const p0 = layout.gridToScreen(a.col, a.row);
  const p1 = layout.gridToScreen(a.col + 1, a.row + 1);
  return { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
}

/** Where the guided card of `beat` should land: the lane's spawn cell, the build slot, or the meteor anchor. */
export function beatTargetPoint(layout: ILayout, beat: BeatSpec, meteorAnchor: { col: number; row: number } | null): { x: number; y: number } {
  if (beat.kind === 'unit') return layout.gridToScreen(beat.col, BOTTOM_SPAWN_ROW);
  if (beat.kind === 'building') return layout.gridToScreen(beat.col, BOTTOM_BUILDING_ROW);
  return meteorAnchor ? meteorAnchorCenter(layout, meteorAnchor) : layout.gridToScreen(beat.col, BOARD_ROWS / 2);
}

/** Live enemy units (the tutorial's local player is always the bottom side). */
export function enemyUnits(state: GameState): { col: number; row: number }[] {
  const out: { col: number; row: number }[] = [];
  for (const u of state.board.units.values()) {
    if (!u.isDead && u.side !== Side.Bottom) out.push({ col: u.col, row: u.row });
  }
  return out;
}

/**
 * The meteor anchor (top-left of its 2×2, SpellSystem.castMeteor) that covers the most enemy units —
 * the aim-assist target for Beat 3. Ties go to the first anchor found, which is stable frame to frame.
 */
export function bestMeteorAnchor(state: GameState): { col: number; row: number } | null {
  const units = enemyUnits(state);
  let best: { col: number; row: number } | null = null;
  let bestHits = 0;
  for (let col = 0; col < BOARD_COLS - 1; col++) {
    for (let row = 0; row < BOARD_ROWS - 1; row++) {
      let hits = 0;
      for (const u of units) if (u.col >= col && u.col <= col + 1 && u.row >= row && u.row <= row + 1) hits++;
      if (hits > bestHits) { bestHits = hits; best = { col, row }; }
    }
  }
  return best;
}
