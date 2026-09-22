import { ATTACK_MULT_LATE_GAME, ATTACK_MULT_THRESHOLD_TICKS, BASE_COLS, BOARD_COLS } from '../../config';
import { addFp, fromFp, mulFp, scaleFp, subFp, TICK_DT_FP, toFp, type Fp } from '../../math/fixed';
import { GameState } from '../../GameState';
import { Board } from '../../Board';
import { Unit } from '../../Unit';
import { Side, UnitState } from '../../types';

// ─── Crossing (horizontal transit toward base, same rules as forward) ─────
//
//  Direction: if x_fp < baseMin → move right (+1); if x_fp > baseMax → move left (-1).
//  Rules (same as moveForward, just in x):
//    1. Enemy building one step ahead → attack and stay put.
//    2. Friendly unit ahead in crossing direction within radius → block.
//    3. Otherwise → advance.
//    4. Reached base cols [5,6] → deal damage and despawn.

export function moveCrossing(unit: Unit, state: GameState): void {
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
        const damage = scaleFp(mult, unit.attack_fp);
        enemyBuilding.takeDamage(damage);
        state.pushEvent({
          type:                 'unit_attack_hit',
          unitId:               unit.id,
          targetId:             enemyBuilding.id,
          damage_fp:            damage,
          targetHpRemaining_fp: enemyBuilding.hp_fp,
        });
        if (!enemyBuilding.isDead) {
          state.pushEvent({
            type:       'building_hp_changed',
            buildingId: enemyBuilding.id,
            hp_fp:      enemyBuilding.hp_fp,
            maxHp_fp:   enemyBuilding.maxHp_fp,
          });
        }
        unit.attackCooldownTicks = unit.attackIntervalTicks;
      }
      // Blocked by building — don't move this tick
      return;
    }
  }

  // ── Friendly collision in crossing direction ───────────────────────────
  const frontUnit = getFriendlyUnitAheadInCrossing(unit, board, direction);
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
    // siege value (ADR-026): base damage on arrival is the unit's siege value, decoupled
    // from combat attack, so siege cost-efficiency is an independent balance lever.
    // Same in every mode (pvp/campaign/siege); PvP uses the read-only base constant.
    const damage_fp     = unit.siegeValue_fp;

    // Track enemy leaks for the campaign `leak_limit` objective.
    if (unit.side === Side.Top) state.enemyLeaks++;

    opponent.takeDamage(damage_fp);
    // ADR-065: damageDealtToBase/damageTakenByBase are match-summary REPORTING stats
    // (client ResultScene badges, campaignRewards.remainingHpPct against the real-unit
    // BASE_HP constant) — kept in real units, not fp, so nothing downstream of the engine
    // needs to change. fromFp() converts back at this boundary, same as any other
    // engine→outside-system crossing (worldsvc troop tally, client display reads).
    state.stats[attackerOwner].damageDealtToBase += fromFp(damage_fp);
    state.stats[defenderOwner].damageTakenByBase += fromFp(damage_fp);

    state.pushEvent({
      type:     'base_hp_changed',
      owner:    defenderOwner,
      hp_fp:    opponent.baseHp_fp,
      maxHp_fp: opponent.maxBaseHp_fp,
    });

    unit.hp_fp = toFp(0);
    unit.state = UnitState.Dead;
    state.board.removeUnit(unit);
  }
}

/**
 * Find the nearest living friendly Crossing unit directly ahead of `unit`
 * in the crossing direction (+1 = right, -1 = left).
 */
function getFriendlyUnitAheadInCrossing(
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
