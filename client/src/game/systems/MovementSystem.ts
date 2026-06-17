import {
  ATTACK_MULT_LATE_GAME,
  ATTACK_MULT_THRESHOLD_TICKS,
  BASE_COLS,
  BASE_HP,
  BOARD_COLS,
  BOTTOM_BUILDING_ROW,
  TOP_BUILDING_ROW,
} from '../config';
import { addFp, fromFp, mulFp, scaleFp, subFp, TICK_DT_FP, toFp, type Fp } from '../math/fixed';
import { GameState } from '../GameState';
import { Board } from '../Board';
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
        this.moveCrossing(unit, state);
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

    // ── Blocked cell ahead — auto-detour ──────────────────────────────────
    const nextRow = unit.row + direction;
    if (nextRow >= 0 && nextRow < 18 && state.board.isBlocked(unit.col, nextRow)) {
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

  // ─── Crossing (horizontal transit toward base, same rules as forward) ─────
  //
  //  Direction: if x_fp < baseMin → move right (+1); if x_fp > baseMax → move left (-1).
  //  Rules (same as moveForward, just in x):
  //    1. Enemy building one step ahead → attack and stay put.
  //    2. Friendly unit ahead in crossing direction within radius → block.
  //    3. Otherwise → advance.
  //    4. Reached base cols [5,6] → deal damage and despawn.

  private moveCrossing(unit: Unit, state: GameState): void {
    const board = state.board;
    const [baseMin, baseMax] = BASE_COLS;
    const baseMinX_fp: Fp    = toFp(baseMin);
    const baseMaxX_fp: Fp    = toFp(baseMax);

    // Which direction is the unit crossing?
    const direction: 1 | -1 = unit.x_fp < baseMinX_fp ? 1 : -1;
    const crossingRow        = unit.row; // TOP_BUILDING_ROW or BOTTOM_BUILDING_ROW

    // ── Cooldown tick ──────────────────────────────────────────────────────
    if (unit.attackCooldownTicks > 0) unit.attackCooldownTicks--;

    // ── Check for enemy building one step ahead (same row, next col) ───────
    const aheadCol = unit.col + direction;
    if (aheadCol >= 0 && aheadCol < BOARD_COLS) {
      const enemyBuilding = board.getBuildingAt(aheadCol, crossingRow);
      if (enemyBuilding && enemyBuilding.side !== unit.side && !enemyBuilding.isDead) {
        if (unit.attackCooldownTicks === 0) {
          const mult   = state.elapsedTicks >= ATTACK_MULT_THRESHOLD_TICKS
            ? ATTACK_MULT_LATE_GAME : 1;
          const damage = unit.attack * mult;
          enemyBuilding.takeDamage(damage);
          state.pushEvent({
            type:              'unit_attack_hit',
            unitId:            unit.id,
            targetId:          enemyBuilding.id,
            damage,
            targetHpRemaining: enemyBuilding.hp,
          });
          if (!enemyBuilding.isDead) {
            state.pushEvent({
              type:       'building_hp_changed',
              buildingId: enemyBuilding.id,
              hp:         enemyBuilding.hp,
              maxHp:      enemyBuilding.maxHp,
            });
          }
          unit.attackCooldownTicks = unit.attackIntervalTicks;
        }
        // Blocked by building — don't move this tick
        return;
      }
    }

    // ── Friendly collision in crossing direction ───────────────────────────
    const frontUnit = this.getFriendlyUnitAheadInCrossing(unit, board, direction);
    if (frontUnit) {
      const gapFp = direction > 0
        ? subFp(subFp(frontUnit.x_fp, frontUnit.radius_fp), addFp(unit.x_fp, unit.radius_fp))
        : subFp(subFp(unit.x_fp, unit.radius_fp), addFp(frontUnit.x_fp, frontUnit.radius_fp));

      // Once stopped, don't resume until there's room for the unit's own
      // footprint ahead — avoids rapid Moving/Waiting flapping when the
      // front unit creeps forward slower than this unit.
      const minGapFp = unit.crossingBlocked ? scaleFp(2, unit.radius_fp) : 0;

      if (gapFp <= minGapFp) {
        if (gapFp <= 0) {
          // Blocked by friendly — push self back to just behind the front unit
          unit.x_fp = direction > 0
            ? subFp(subFp(frontUnit.x_fp, frontUnit.radius_fp), unit.radius_fp)
            : addFp(addFp(frontUnit.x_fp, frontUnit.radius_fp), unit.radius_fp);
          unit.col = Math.round(fromFp(unit.x_fp));
        }
        unit.crossingBlocked = true;
        return;
      }
    }
    unit.crossingBlocked = false;

    // ── Advance in crossing direction ──────────────────────────────────────
    const dx: Fp = mulFp(unit.speed_fp, TICK_DT_FP);
    if (direction > 0) {
      unit.x_fp = addFp(unit.x_fp, dx);
      if (unit.x_fp > baseMinX_fp) unit.x_fp = baseMinX_fp;
    } else {
      unit.x_fp = subFp(unit.x_fp, dx);
      if (unit.x_fp < baseMaxX_fp) unit.x_fp = baseMaxX_fp;
    }
    unit.col = Math.round(fromFp(unit.x_fp));

    // ── Reached base cols [baseMin, baseMax] → damage + despawn ───────────
    if (unit.x_fp >= baseMinX_fp && unit.x_fp <= baseMaxX_fp) {
      const opponent      = state.getOpponent(unit.side);
      const attackerOwner = state.ownerOf(unit.side);
      const defenderOwner = state.ownerOf(opponent.side);
      const damage        = unit.attack;

      // Track enemy leaks for the campaign `leak_limit` objective.
      if (unit.side === Side.Top) state.enemyLeaks++;

      opponent.takeDamage(damage);
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

  /**
   * Find the nearest living friendly Crossing unit directly ahead of `unit`
   * in the crossing direction (+1 = right, -1 = left).
   */
  private getFriendlyUnitAheadInCrossing(
    unit:      Unit,
    board:     Board,
    direction: 1 | -1,
  ): Unit | null {
    let bestUnit: Unit | null = null;
    let bestDist = Infinity;

    for (const other of board.units.values()) {
      // State check first: most units are in lanes, not Crossing, so this is
      // the most selective (and cheapest) filter — it skips the common case.
      if (other.state !== UnitState.Crossing) continue;
      if (other.id === unit.id)              continue;
      if (other.side !== unit.side)          continue;
      if (other.isDead)                      continue;

      const isAhead = direction > 0 ? other.x_fp > unit.x_fp : other.x_fp < unit.x_fp;
      if (!isAhead) continue;

      const dist = Math.abs(other.x_fp - unit.x_fp);
      if (dist < bestDist) {
        bestDist = dist;
        bestUnit = other;
      }
    }

    return bestUnit;
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
