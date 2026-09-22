import { BOARD_COLS, BOTTOM_BUILDING_ROW, TOP_BUILDING_ROW } from '../config';
import { addFp, fromFp, mulFp, scaleFp, subFp, TICK_DT_FP, toFp, type Fp } from '../math/fixed';
import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { Side, UnitState } from '../types';
import { moveCrossing } from './movement/crossing';
import { tryOverflowDetour } from './movement/laneOverflow';

/**
 * MovementSystem — advances unit positions by one tick.
 *
 * Coordinate convention (0-indexed):
 *   Row 0  = Bottom building row (home base).
 *   Row 17 = Top building row (enemy base for Bottom).
 *   Bottom units spawn at row 1 and move TOWARD row 17 (y_fp increases, direction = +1).
 *   Top    units spawn at row 16 and move TOWARD row 0  (y_fp decreases, direction = -1).
 *
 * Crossing:
 *   When a Bottom unit reaches row 17 it enters Crossing state and moves in +x or -x
 *   toward base cols 5–6.  Crossing follows the same rules as forward movement:
 *   friendly-collision blocking and enemy-building attacks, just in the x direction.
 *
 * All position arithmetic uses Fp helpers. No floating-point operations.
 */
export class MovementSystem {
  tick(state: GameState): void {
    const board = state.board;

    // Iterate the live Map directly — no per-tick snapshot allocation.
    // Safe because the only mutation during this loop is moveCrossing()
    // removing the *current* unit when it reaches the base; deleting the entry
    // currently being visited is well-defined for Map iterators (the next
    // entry is still visited) and MovementSystem never adds units.
    for (const unit of board.units.values()) {
      if (unit.isDead || unit.state === UnitState.Attacking) continue;

      const prevState = unit.state;
      const prevRow   = unit.row;
      const prevCol   = unit.col;

      if (unit.state === UnitState.Crossing) {
        moveCrossing(unit, state);
      } else if (unit.state === UnitState.Detour) {
        this.moveDetour(unit, state);
      } else {
        this.moveForward(unit, state);
      }

      this.emitMoveEvents(unit, prevState, state);
      board.updateUnitCell(unit, prevRow, prevCol);
    }

    // Sweep units that died this tick (e.g. in an earlier system) but are
    // still present. Every visited unit is in the Map, so deleting the current
    // entry mid-iteration is safe and no has()-guard is needed.
    for (const unit of board.units.values()) {
      if (unit.isDead) board.removeUnit(unit);
    }
  }

  // ─── Forward movement (along lane) ───────────────────────────────────────

  private moveForward(unit: Unit, state: GameState): void {
    const board    = state.board;
    const isBottom = unit.side === Side.Bottom;
    // Cleared here and re-armed only by the friendly-collision branch below, so
    // every other outcome of this tick (advancing, detouring, crossing) resets
    // the lane-overflow countdown without each path having to remember to.
    const waitedTicks = unit.waitingTicks;
    unit.waitingTicks = 0;
    // Bottom moves toward row 17 (+1); Top moves toward row 0 (-1).
    const direction = isBottom ? 1 : -1;
    // The building row of the opponent — reaching it triggers crossing.
    const crossingY_fp: Fp = isBottom ? toFp(TOP_BUILDING_ROW) : toFp(BOTTOM_BUILDING_ROW);

    // ── Crossing threshold check ───────────────────────────────────────────
    if (isBottom && unit.y_fp >= crossingY_fp) {
      unit.y_fp  = crossingY_fp;
      unit.state = UnitState.Crossing;
      return;
    }
    if (!isBottom && unit.y_fp <= crossingY_fp) {
      unit.y_fp  = crossingY_fp;
      unit.state = UnitState.Crossing;
      return;
    }

    // ── Cross-waypoint trigger (scripted lane switch) ──────────────────────
    if (unit.pendingWaypoints.length > 0) {
      const wp = unit.pendingWaypoints[0]!;
      const triggerMet = isBottom ? unit.row >= wp.atRow : unit.row <= wp.atRow;
      if (triggerMet) {
        unit.pendingWaypoints.shift();
        if (unit.col !== wp.toCol) {
          unit.detourTargetCol = wp.toCol;
          unit.detourDir = (wp.toCol > unit.col ? 1 : -1) as 1 | -1;
          unit.state = UnitState.Detour;
          return;
        }
      }
    }

    // ── Entire column blocked by BridgeCollapse — force detour ───────────
    if (state.tempBlockedCols.has(unit.col)) {
      if (unit.detourDir === 0) {
        unit.detourDir = (unit.col < 5.5 ? 1 : -1) as 1 | -1;
      }
      unit.detourTargetCol = unit.col + unit.detourDir;
      unit.state = UnitState.Detour;
      return;
    }

    // ── Blocked cell ahead — auto-detour (flying units bypass) ──────────────
    const nextRow = unit.row + direction;
    if (!unit.flying && nextRow >= 0 && nextRow < 18 && state.board.isBlocked(unit.col, nextRow)) {
      // Pick detour direction: prefer existing dir, else toward board center
      if (unit.detourDir === 0) {
        unit.detourDir = (unit.col < 5.5 ? 1 : -1) as 1 | -1;
      }
      unit.detourTargetCol = unit.col + unit.detourDir;
      unit.state = UnitState.Detour;
      return;
    }

    // ── Friendly collision (radius-based) ──────────────────────────────────
    const frontUnit = board.getFriendlyUnitAhead(unit);
    if (frontUnit) {
      const gapFp = isBottom
        ? subFp(subFp(frontUnit.y_fp, frontUnit.radius_fp), addFp(unit.y_fp, unit.radius_fp))
        : subFp(subFp(unit.y_fp, unit.radius_fp), addFp(frontUnit.y_fp, frontUnit.radius_fp));

      // Once stopped, don't resume until there's room for the unit's own
      // footprint ahead — avoids rapid Moving/Waiting flapping when the
      // front unit creeps forward slower than this unit.
      const minGapFp = unit.state === UnitState.Waiting ? scaleFp(2, unit.radius_fp) : 0;

      if (gapFp <= minGapFp) {
        if (gapFp <= 0) {
          unit.y_fp = isBottom
            ? subFp(subFp(frontUnit.y_fp, frontUnit.radius_fp), unit.radius_fp)
            : addFp(addFp(frontUnit.y_fp, frontUnit.radius_fp), unit.radius_fp);
        }
        unit.state        = UnitState.Waiting;
        unit.waitingTicks = waitedTicks + 1;
        // Stuck deep in a lane queue — bleed off sideways instead of waiting forever.
        tryOverflowDetour(unit, state);
        return;
      }
    }

    // ── Advance ────────────────────────────────────────────────────────────
    const dy: Fp = mulFp(unit.speed_fp, TICK_DT_FP);
    let newY: Fp = addFp(unit.y_fp, scaleFp(direction, dy));

    // Clamp so we don't overshoot the crossing threshold
    if (isBottom  && newY > crossingY_fp) newY = crossingY_fp;
    if (!isBottom && newY < crossingY_fp) newY = crossingY_fp;

    // ── Enemy ahead — stop one cell short so CombatSystem can engage ─────────
    // This unit is non-Attacking (Attacking units skip movement entirely), so
    // CombatSystem did NOT engage an enemy this tick — typically because the two
    // round to a cell-distance > range while their continuous gap is ~1 grid.
    // Advancing freely would let it round straight into the enemy's own cell
    // (distance 0), which findTarget never scans, and it would sail past. Keep
    // the centre-to-centre gap >= 1 grid: that guarantees a cell-distance of 1,
    // where CombatSystem picks the target up on the next tick.
    const enemyAhead = board.getEnemyUnitAhead(unit);
    if (enemyAhead) {
      const oneCellFp: Fp = toFp(1);
      if (isBottom) {
        const limit = subFp(enemyAhead.y_fp, oneCellFp);
        if (newY > limit) newY = limit;
      } else {
        const limit = addFp(enemyAhead.y_fp, oneCellFp);
        if (newY < limit) newY = limit;
      }
    }

    const advanced = newY !== unit.y_fp;
    unit.y_fp  = newY;
    unit.state = advanced ? UnitState.Moving : UnitState.Waiting;
  }

  // ─── Detour (lateral redirect around blocked cell or crossWaypoint) ─────────

  private moveDetour(unit: Unit, state: GameState): void {
    const board = state.board;
    const targetCol = unit.detourTargetCol;
    if (targetCol === null) {
      unit.state = UnitState.Moving;
      return;
    }

    const dir = unit.detourDir as 1 | -1;

    // Advance one step laterally this tick
    const dx: Fp = mulFp(unit.speed_fp, TICK_DT_FP);
    if (dir > 0) {
      unit.x_fp = addFp(unit.x_fp, dx);
      if (unit.x_fp > toFp(targetCol)) unit.x_fp = toFp(targetCol);
    } else {
      unit.x_fp = subFp(unit.x_fp, dx);
      if (unit.x_fp < toFp(targetCol)) unit.x_fp = toFp(targetCol);
    }
    unit.col = Math.round(fromFp(unit.x_fp));

    // Check if we've arrived at the target col
    if (unit.col === targetCol) {
      const isBottom = unit.side === Side.Bottom;
      const direction = isBottom ? 1 : -1;
      const nextRow = unit.row + direction;

      if (nextRow >= 0 && nextRow < 18 && board.isBlocked(unit.col, nextRow)) {
        // Forward is still blocked — extend detour by one more col in same dir
        let newTarget = targetCol + dir;
        if (newTarget < 0 || newTarget >= BOARD_COLS) {
          // Reverse direction at board edge
          unit.detourDir = (dir > 0 ? -1 : 1) as 1 | -1;
          newTarget = targetCol + unit.detourDir;
        }
        unit.detourTargetCol = newTarget;
      } else {
        // Path is clear ahead — resume forward movement
        unit.detourTargetCol = null;
        unit.detourDir = dir; // keep dir so we don't immediately re-detour in same direction
        unit.state = UnitState.Moving;
      }
    }
    (void board);
  }

  // ─── Move event emission ──────────────────────────────────────────────────

  private emitMoveEvents(unit: Unit, prevState: UnitState, state: GameState): void {
    const wasMoving = prevState === UnitState.Moving;
    const isMoving  = unit.state === UnitState.Moving;

    if (!wasMoving && isMoving) {
      state.pushEvent({
        type:     'unit_move_start',
        unitId:   unit.id,
        from:     { col: unit.col, y_fp: unit.y_fp },
        to:       { col: unit.col, y_fp: this.predictStopY(unit, state) },
        speed_fp: unit.speed_fp,
      });
    } else if (wasMoving && !isMoving) {
      state.pushEvent({
        type:   'unit_move_stop',
        unitId: unit.id,
        pos:    { col: unit.col, y_fp: unit.y_fp },
      });
    }
  }

  /**
   * Best-effort prediction of where a unit will stop.
   * Finds the nearest enemy unit/building ahead in the lane.
   * Falls back to the crossing threshold if nothing is in the way.
   */
  private predictStopY(unit: Unit, state: GameState): Fp {
    const board      = state.board;
    const isBottom   = unit.side === Side.Bottom;
    const crossingY_fp: Fp = isBottom ? toFp(TOP_BUILDING_ROW) : toFp(BOTTOM_BUILDING_ROW);
    const rangeFp: Fp      = toFp(unit.effectiveRange);

    let stopY_fp: Fp = crossingY_fp;

    for (const enemy of board.units.values()) {
      if (enemy.side === unit.side || enemy.col !== unit.col || enemy.isDead) continue;

      if (isBottom && enemy.y_fp > unit.y_fp) {
        const candidate = subFp(subFp(enemy.y_fp, enemy.radius_fp), addFp(unit.radius_fp, rangeFp));
        if (candidate < stopY_fp) stopY_fp = candidate;
      } else if (!isBottom && enemy.y_fp < unit.y_fp) {
        const candidate = addFp(addFp(enemy.y_fp, enemy.radius_fp), addFp(unit.radius_fp, rangeFp));
        if (candidate > stopY_fp) stopY_fp = candidate;
      }
    }

    // Check for enemy building ahead
    const enemyBuildingRow = isBottom ? TOP_BUILDING_ROW : BOTTOM_BUILDING_ROW;
    const enemyBuilding    = board.getBuildingAt(unit.col, enemyBuildingRow);
    if (enemyBuilding && enemyBuilding.side !== unit.side && !enemyBuilding.isDead) {
      const buildingY_fp: Fp = toFp(enemyBuildingRow);
      if (isBottom) {
        const candidate = subFp(buildingY_fp, rangeFp);
        if (candidate < stopY_fp) stopY_fp = candidate;
      } else {
        const candidate = addFp(buildingY_fp, rangeFp);
        if (candidate > stopY_fp) stopY_fp = candidate;
      }
    }

    return stopY_fp;
  }
}
