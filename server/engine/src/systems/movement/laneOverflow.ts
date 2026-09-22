import { BOARD_ROWS, OVERFLOW_DETOUR_MIN_ENEMY_GAP, OVERFLOW_DETOUR_WAIT_TICKS } from '../../config';
import { subFp, toFp } from '../../math/fixed';
import { GameState } from '../../GameState';
import { Unit } from '../../Unit';
import { Side, UnitState } from '../../types';

// ─── Lane overflow (queue side-step) ───────────────────────────────────────

/**
 * A unit parked behind friendlies for {@link OVERFLOW_DETOUR_WAIT_TICKS} with
 * clear road ahead side-steps into the emptier neighbouring lane rather than
 * queueing indefinitely. Returns true when a Detour was started.
 *
 * Melee range is 1, so only the front two of a column ever swing: without this
 * a lane queue was free stored ink that instantly refilled the front rank.
 * The {@link OVERFLOW_DETOUR_MIN_ENEMY_GAP} guard is what keeps a push from
 * dissolving on contact — units holding the line stay, only the deep tail moves.
 */
export function tryOverflowDetour(unit: Unit, state: GameState): boolean {
  if (unit.waitingTicks < OVERFLOW_DETOUR_WAIT_TICKS) return false;
  if (enemyWithin(unit, state, OVERFLOW_DETOUR_MIN_ENEMY_GAP)) return false;

  const board   = state.board;
  const left    = unit.col - 1;
  const right   = unit.col + 1;
  const leftOk  = board.isUsableLane(left)  && canEnterLane(unit, left, state);
  const rightOk = board.isUsableLane(right) && canEnterLane(unit, right, state);
  if (!leftOk && !rightOk) return false;

  let dir: 1 | -1;
  if (leftOk && rightOk) {
    const nLeft  = board.countSideUnitsInColumn(left, unit.side);
    const nRight = board.countSideUnitsInColumn(right, unit.side);
    // Emptier lane wins; on a tie head toward the board centre, matching the
    // blocked-cell detour's tie-break.
    dir = nLeft === nRight
      ? ((unit.col < 5.5 ? 1 : -1) as 1 | -1)
      : ((nLeft < nRight ? -1 : 1) as 1 | -1);
  } else {
    dir = leftOk ? -1 : 1;
  }

  unit.detourDir       = dir;
  unit.detourTargetCol = unit.col + dir;
  unit.state           = UnitState.Detour;
  unit.waitingTicks    = 0;
  return true;
}

/** True if an enemy unit or building sits within `rows` ahead of `unit` in its own lane. */
function enemyWithin(unit: Unit, state: GameState, rows: number): boolean {
  const board    = state.board;
  const isBottom = unit.side === Side.Bottom;

  const enemy = board.getEnemyUnitAhead(unit);
  if (enemy) {
    const gapFp = isBottom
      ? subFp(enemy.y_fp, unit.y_fp)
      : subFp(unit.y_fp, enemy.y_fp);
    if (gapFp <= toFp(rows)) return true;
  }

  const direction = isBottom ? 1 : -1;
  for (let i = 1; i <= rows; i++) {
    const row = unit.row + direction * i;
    if (row < 0 || row >= BOARD_ROWS) break;
    const building = board.getBuildingAt(unit.col, row);
    if (building && !building.isDead && building.side !== unit.side) return true;
  }
  return false;
}

/** True if `unit` may step into lane `col` at its current row. */
function canEnterLane(unit: Unit, col: number, state: GameState): boolean {
  if (state.tempBlockedCols.has(col)) return false;
  if (unit.flying) return true;
  return !state.board.isBlocked(col, unit.row);
}
