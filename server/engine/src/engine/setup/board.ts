// Apply a campaign/siege level's board shaping to a fresh GameState — verbatim extract
// of engine/base.ts's old constructor (blocked/no-build/active-lane/hazard/startInk/
// inkRegenMult/laneLength setup, PvE-shaped modes only).
import { BOARD_ROWS, TOP_SPAWN_ROW } from '../../config';
import { toFp } from '../../math/fixed';
import type { GameState } from '../../GameState';
import type { LevelDefinition } from '../../campaign/LevelDefinition';

export function applyBoardSetup(state: GameState, level: LevelDefinition): void {
  const blocked = level.board?.cellMask?.blocked;
  if (blocked && blocked.length > 0) state.board.setBlocked(blocked);
  const noBuild = level.board?.cellMask?.noBuild;
  if (noBuild && noBuild.length > 0) state.board.setNoBuild(noBuild);
  const activeLanes = level.board?.activeLanes;
  if (activeLanes && activeLanes.length > 0) state.board.setActiveLanes(activeLanes);
  if (level.hazards && level.hazards.length > 0) {
    state.hazards = level.hazards;
  }
  if (level.startInk) {
    state.bottomPlayer.addInkFp(toFp(level.startInk));
  }

  // Ink regen multiplier for the bottom (human) player.
  if (level.inkRegenMult !== undefined) {
    state.bottomInkRegenMult = level.inkRegenMult;
  }

  // laneLength (§4.9.1): truncate the top of each specified lane so enemies spawn closer to
  // the player's base. Rows above the new spawn row are added to the blocked set (merged
  // with any cellMask.blocked from the level JSON).
  const laneLength = level.board?.laneLength;
  if (laneLength) {
    const laneLengthBlocked: { col: number; row: number }[] = [];
    for (const [colStr, len] of Object.entries(laneLength)) {
      const col = Number(colStr);
      const spawnRow = BOARD_ROWS - len;
      for (let row = spawnRow + 1; row <= TOP_SPAWN_ROW; row++) {
        laneLengthBlocked.push({ col, row });
      }
    }
    if (laneLengthBlocked.length > 0) {
      const existing = state.board.getBlockedCells();
      state.board.setBlocked([...existing, ...laneLengthBlocked]);
    }
  }
}
