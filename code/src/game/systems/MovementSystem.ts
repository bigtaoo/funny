import {
  BASE_COLS,
  BASE_HP,
  BOTTOM_BUILDING_ROW,
  BOTTOM_TRANSIT_ROW,
  CROSSING_INTERVAL_TICKS,
  TOP_BUILDING_ROW,
  TOP_TRANSIT_ROW,
} from '../config';
import { addFp, mulFp, scaleFp, subFp, TICK_DT_FP, toFp, type Fp } from '../math/fixed';
import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { Side, UnitState } from '../types';

/**
 * MovementSystem — advances unit positions by one tick.
 *
 * All position arithmetic uses Fp helpers (addFp/subFp/mulFp/scaleFp).
 * No floating-point operations.
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

    // Remove dead units (guard against double-remove for crossing units)
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
    // Bottom moves toward lower y (toward row 0); Top moves toward higher y.
    const direction = isBottom ? -1 : 1;
    const transitY_fp: Fp = isBottom ? toFp(TOP_TRANSIT_ROW) : toFp(BOTTOM_TRANSIT_ROW);

    // ── Transit threshold check ────────────────────────────────────────────
    if (isBottom && unit.y_fp <= transitY_fp) {
      unit.y_fp = transitY_fp;
      unit.state = UnitState.Crossing;
      // Start cooldown so the first column step is rate-limited like all subsequent steps.
      // Without this, crossingCooldownTicks = 0 would cause an immediate step next tick.
      unit.crossingCooldownTicks = CROSSING_INTERVAL_TICKS;
      return;
    }
    if (!isBottom && unit.y_fp >= transitY_fp) {
      unit.y_fp = transitY_fp;
      unit.state = UnitState.Crossing;
      unit.crossingCooldownTicks = CROSSING_INTERVAL_TICKS;
      return;
    }

    // ── Friendly collision (radius-based) ──────────────────────────────────
    const frontUnit = board.getFriendlyUnitAhead(unit);
    if (frontUnit) {
      // gap = distance between the two radii edges
      // Bottom: gap = (unit.y_fp - unit.radius_fp) - (front.y_fp + front.radius_fp)
      // Top:    gap = (front.y_fp - front.radius_fp) - (unit.y_fp  + unit.radius_fp)
      const gapFp = isBottom
        ? subFp(subFp(unit.y_fp, unit.radius_fp), addFp(frontUnit.y_fp, frontUnit.radius_fp))
        : subFp(subFp(frontUnit.y_fp, frontUnit.radius_fp), addFp(unit.y_fp, unit.radius_fp));

      if (gapFp <= 0) {
        // Clamp to exactly touching — no overlap
        unit.y_fp = isBottom
          ? addFp(addFp(frontUnit.y_fp, frontUnit.radius_fp), unit.radius_fp)
          : subFp(subFp(frontUnit.y_fp, frontUnit.radius_fp), unit.radius_fp);
        unit.state = UnitState.Waiting;
        return;
      }
    }

    // ── Advance ────────────────────────────────────────────────────────────
    const dy: Fp = mulFp(unit.speed_fp, TICK_DT_FP); // fp displacement this tick
    unit.y_fp    = addFp(unit.y_fp, scaleFp(direction, dy));
    unit.state   = UnitState.Moving;

    // Clamp so we don't overshoot the transit row
    if (isBottom && unit.y_fp < transitY_fp) unit.y_fp = transitY_fp;
    if (!isBottom && unit.y_fp > transitY_fp) unit.y_fp = transitY_fp;
  }

  // ─── Crossing (horizontal transit toward base) ────────────────────────────

  private moveCrossing(unit: Unit, state: GameState): void {
    const [targetColMin, targetColMax] = BASE_COLS; // cols 3–4

    if (unit.col >= targetColMin && unit.col <= targetColMax) {
      // Reached base column — deal damage and despawn
      const opponent = state.getOpponent(unit.side);
      opponent.takeDamage(unit.attack);

      state.pushEvent({
        type:   'base_hp_changed',
        owner:  state.ownerOf(opponent.side),
        hp:     opponent.baseHp,
        maxHp:  BASE_HP,
      });

      unit.hp    = 0;
      unit.state = UnitState.Dead;
      state.board.removeUnit(unit);
    } else {
      // Rate-limited horizontal step: one column every CROSSING_INTERVAL_TICKS ticks
      if (unit.crossingCooldownTicks > 0) {
        unit.crossingCooldownTicks--;
        return;
      }
      unit.col += unit.col < targetColMin ? 1 : -1;
      unit.crossingCooldownTicks = CROSSING_INTERVAL_TICKS;
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
   * Falls back to the transit row if nothing is in the way.
   */
  private predictStopY(unit: Unit, state: GameState): Fp {
    const board     = state.board;
    const isBottom  = unit.side === Side.Bottom;
    const transitY_fp: Fp = isBottom ? toFp(TOP_TRANSIT_ROW) : toFp(BOTTOM_TRANSIT_ROW);
    const rangeFp: Fp     = toFp(unit.range);

    let stopY_fp: Fp = transitY_fp;

    for (const enemy of board.units.values()) {
      if (enemy.side === unit.side || enemy.col !== unit.col || enemy.isDead) continue;

      if (isBottom && enemy.y_fp < unit.y_fp) {
        // Unit will stop at: enemy.y_fp + enemy.radius + unit.radius + range
        const candidate = addFp(addFp(addFp(enemy.y_fp, enemy.radius_fp), unit.radius_fp), rangeFp);
        if (candidate > stopY_fp) stopY_fp = candidate;
      } else if (!isBottom && enemy.y_fp > unit.y_fp) {
        const candidate = subFp(subFp(subFp(enemy.y_fp, enemy.radius_fp), unit.radius_fp), rangeFp);
        if (candidate < stopY_fp) stopY_fp = candidate;
      }
    }

    // Check for enemy building ahead
    const enemyBuildingRow = isBottom ? TOP_BUILDING_ROW : BOTTOM_BUILDING_ROW;
    const enemyBuilding    = board.getBuildingAt(unit.col, enemyBuildingRow);
    if (enemyBuilding && enemyBuilding.side !== unit.side && !enemyBuilding.isDead) {
      const buildingY_fp: Fp = toFp(enemyBuildingRow);
      if (isBottom) {
        const candidate = addFp(buildingY_fp, rangeFp);
        if (candidate > stopY_fp) stopY_fp = candidate;
      } else {
        const candidate = subFp(buildingY_fp, rangeFp);
        if (candidate < stopY_fp) stopY_fp = candidate;
      }
    }

    return stopY_fp;
  }
}
