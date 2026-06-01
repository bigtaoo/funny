import {
  BASE_COLS,
  BASE_HP,
  BOTTOM_BUILDING_ROW,
  TOP_BUILDING_ROW,
} from '../config';
import { addFp, fromFp, mulFp, scaleFp, subFp, TICK_DT_FP, toFp, type Fp } from '../math/fixed';
import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { Side, UnitState } from '../types';

/**
 * MovementSystem — advances unit positions by one tick.
 *
 * Coordinate convention (0-indexed):
 *   Row 0  = Bottom building row (home base).
 *   Row 17 = Top building row (enemy base for Bottom).
 *   Bottom units spawn at row 1 and move TOWARD row 17 (y_fp increases, direction = +1).
 *   Top    units spawn at row 16 and move TOWARD row 0  (y_fp decreases, direction = -1).
 *
 * All position arithmetic uses Fp helpers. No floating-point operations.
 */
export class MovementSystem {
  tick(state: GameState): void {
    const board = state.board;
    const units = Array.from(board.units.values());

    for (const unit of units) {
      if (unit.isDead || unit.state === UnitState.Attacking) continue;

      const prevState = unit.state;
      const prevRow   = unit.row;

      if (unit.state === UnitState.Crossing) {
        this.moveCrossing(unit, state);
      } else {
        this.moveForward(unit, state);
      }

      this.emitMoveEvents(unit, prevState, state);
      board.updateUnitCell(unit, prevRow);
    }

    // Remove units killed during crossing (guard against double-remove)
    for (const unit of units) {
      if (unit.isDead && board.units.has(unit.id)) {
        board.removeUnit(unit);
      }
    }
  }

  // ─── Forward movement (along lane) ───────────────────────────────────────

  private moveForward(unit: Unit, state: GameState): void {
    const board    = state.board;
    const isBottom = unit.side === Side.Bottom;
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

    // ── Friendly collision (radius-based) ──────────────────────────────────
    const frontUnit = board.getFriendlyUnitAhead(unit);
    if (frontUnit) {
      // gap = space between the two radii edges.
      // Bottom (+1): front unit has higher y. gap = (front.y - front.r) - (unit.y + unit.r)
      // Top    (-1): front unit has lower y.  gap = (unit.y - unit.r)   - (front.y + front.r)
      const gapFp = isBottom
        ? subFp(subFp(frontUnit.y_fp, frontUnit.radius_fp), addFp(unit.y_fp, unit.radius_fp))
        : subFp(subFp(unit.y_fp, unit.radius_fp), addFp(frontUnit.y_fp, frontUnit.radius_fp));

      if (gapFp <= 0) {
        unit.y_fp = isBottom
          ? subFp(subFp(frontUnit.y_fp, frontUnit.radius_fp), unit.radius_fp)
          : addFp(addFp(frontUnit.y_fp, frontUnit.radius_fp), unit.radius_fp);
        unit.state = UnitState.Waiting;
        return;
      }
    }

    // ── Advance ────────────────────────────────────────────────────────────
    const dy: Fp = mulFp(unit.speed_fp, TICK_DT_FP);
    unit.y_fp    = addFp(unit.y_fp, scaleFp(direction, dy));
    unit.state   = UnitState.Moving;

    // Clamp so we don't overshoot
    if (isBottom  && unit.y_fp > crossingY_fp) unit.y_fp = crossingY_fp;
    if (!isBottom && unit.y_fp < crossingY_fp) unit.y_fp = crossingY_fp;
  }

  // ─── Crossing (horizontal transit toward base) ────────────────────────────

  private moveCrossing(unit: Unit, state: GameState): void {
    const [baseMin, baseMax] = BASE_COLS; // cols 5–6
    const baseMinX_fp: Fp = toFp(baseMin);
    const baseMaxX_fp: Fp = toFp(baseMax);

    const dx: Fp = mulFp(unit.speed_fp, TICK_DT_FP);

    if (unit.x_fp < baseMinX_fp) {
      unit.x_fp = addFp(unit.x_fp, dx);
      if (unit.x_fp > baseMinX_fp) unit.x_fp = baseMinX_fp;
    } else if (unit.x_fp > baseMaxX_fp) {
      unit.x_fp = subFp(unit.x_fp, dx);
      if (unit.x_fp < baseMaxX_fp) unit.x_fp = baseMaxX_fp;
    }

    unit.col = Math.round(fromFp(unit.x_fp));

    // Reached base — deal damage, track stats, despawn
    if (unit.x_fp >= baseMinX_fp && unit.x_fp <= baseMaxX_fp) {
      const opponent   = state.getOpponent(unit.side);
      const attackerOwner = state.ownerOf(unit.side);
      const defenderOwner = state.ownerOf(opponent.side);
      const damage     = unit.attack;

      opponent.takeDamage(damage);

      // Track stats for both sides
      state.stats[attackerOwner].damageDealtToBase += damage;
      state.stats[defenderOwner].damageTakenByBase += damage;

      state.pushEvent({
        type:  'base_hp_changed',
        owner: defenderOwner,
        hp:    opponent.baseHp,
        maxHp: BASE_HP,
      });

      unit.hp    = 0;
      unit.state = UnitState.Dead;
      state.board.removeUnit(unit);
    }
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
    const rangeFp: Fp      = toFp(unit.range);

    let stopY_fp: Fp = crossingY_fp;

    for (const enemy of board.units.values()) {
      if (enemy.side === unit.side || enemy.col !== unit.col || enemy.isDead) continue;

      if (isBottom && enemy.y_fp > unit.y_fp) {
        // Bottom moves up: enemy is ahead if higher y
        const candidate = subFp(subFp(enemy.y_fp, enemy.radius_fp), addFp(unit.radius_fp, rangeFp));
        if (candidate < stopY_fp) stopY_fp = candidate;
      } else if (!isBottom && enemy.y_fp < unit.y_fp) {
        // Top moves down: enemy is ahead if lower y
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
