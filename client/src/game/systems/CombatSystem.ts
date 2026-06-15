import { ATTACK_MULT_LATE_GAME, ATTACK_MULT_THRESHOLD_TICKS, BOARD_COLS, BOARD_ROWS } from '../config';
import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { Building } from '../Building';
import { Side, UnitState } from '../types';

/**
 * CombatSystem — tick-based attack cooldowns, no floating-point.
 *
 * Direction convention:
 *   Bottom (+1): looks for targets at higher row numbers (rows above).
 *   Top    (-1): looks for targets at lower  row numbers (rows below).
 */
export class CombatSystem {
  tick(state: GameState): void {
    const board = state.board;

    const attackMult = state.elapsedTicks >= ATTACK_MULT_THRESHOLD_TICKS
      ? ATTACK_MULT_LATE_GAME
      : 1;

    // ── Units attack ───────────────────────────────────────────────────────
    for (const unit of board.units.values()) {
      if (unit.isDead || unit.state === UnitState.Crossing) continue;

      if (unit.attackCooldownTicks > 0) unit.attackCooldownTicks--;

      const target = this.findTarget(unit, state);
      if (target) {
        if (unit.state !== UnitState.Attacking) {
          state.pushEvent({ type: 'unit_attack_start', unitId: unit.id, targetId: target.id });
          unit.targetId = target.id;
          unit.state    = UnitState.Attacking;
        }
        if (unit.attackCooldownTicks === 0) {
          this.performUnitAttack(unit, target, state, attackMult);
          unit.attackCooldownTicks = unit.attackIntervalTicks;
        }
      } else {
        if (unit.state === UnitState.Attacking) {
          unit.state    = UnitState.Moving;
          unit.targetId = null;
        }
      }
    }

    // ── Arrow towers attack ────────────────────────────────────────────────
    for (const building of board.buildings.values()) {
      if (building.isDead || !building.isDefender) continue;

      if (building.attackCooldownTicks > 0) building.attackCooldownTicks--;
      if (building.attackCooldownTicks === 0) {
        const target = this.findTargetForBuilding(building, state);
        if (target) {
          this.performBuildingAttack(building, target, state, attackMult);
          building.attackCooldownTicks = building.attackIntervalTicks;
        }
      }
    }

    // ── Remove dead units ──────────────────────────────────────────────────
    for (const unit of Array.from(board.units.values())) {
      if (unit.isDead) {
        // Credit kill to the opponent
        const killerOwner = state.ownerOf(unit.side === Side.Bottom ? Side.Top : Side.Bottom);
        state.stats[killerOwner].unitsKilled++;

        state.pushEvent({ type: 'unit_died', unitId: unit.id, pos: { col: unit.col, y_fp: unit.y_fp } });
        board.removeUnit(unit);
      }
    }

    // ── Remove destroyed buildings ─────────────────────────────────────────
    for (const building of Array.from(board.buildings.values())) {
      if (building.isDead) {
        state.pushEvent({
          type:       'building_destroyed',
          buildingId: building.id,
          col:        building.col,
          row:        building.row,
        });
        board.removeBuilding(building);
      }
    }
  }

  // ─── Target finding ───────────────────────────────────────────────────────

  private findTarget(unit: Unit, state: GameState): Unit | Building | null {
    const board = state.board;

    // Units advance single-file along their lane, but engage ANY enemy within
    // attack range around them (Chebyshev distance), not just the cell straight
    // ahead. Scan ring by ring so the closest target is preferred; within a ring,
    // an enemy unit takes priority over a building in the same cell.
    for (let dist = 1; dist <= unit.range; dist++) {
      let buildingHit: Building | null = null;
      for (let dr = -dist; dr <= dist; dr++) {
        for (let dc = -dist; dc <= dist; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== dist) continue; // outer ring only
          const checkRow = unit.row + dr;
          const checkCol = unit.col + dc;
          if (checkRow < 0 || checkRow >= BOARD_ROWS) continue;
          if (checkCol < 0 || checkCol >= BOARD_COLS) continue;

          const enemy = board.getUnitAt(checkCol, checkRow);
          if (enemy && enemy.side !== unit.side && !enemy.isDead) return enemy;

          if (!buildingHit) {
            const building = board.getBuildingAt(checkCol, checkRow);
            if (building && building.side !== unit.side && !building.isDead) buildingHit = building;
          }
        }
      }
      // No enemy unit in this ring — fall back to a building found in the same ring.
      if (buildingHit) return buildingHit;
    }
    return null;
  }

  private findTargetForBuilding(building: Building, state: GameState): Unit | null {
    const board     = state.board;
    const enemySide = building.side === Side.Bottom ? Side.Top : Side.Bottom;
    const range     = building.attackRange;

    // Scan all cells within attackRange in every direction (Chebyshev distance),
    // ring by ring so closer targets are preferred.
    for (let dist = 1; dist <= range; dist++) {
      for (let dr = -dist; dr <= dist; dr++) {
        for (let dc = -dist; dc <= dist; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== dist) continue; // outer ring only
          const checkRow = building.row + dr;
          const checkCol = building.col + dc;
          if (checkRow < 0 || checkRow >= BOARD_ROWS) continue;
          if (checkCol < 0 || checkCol >= BOARD_COLS) continue;
          const unit = board.getUnitAt(checkCol, checkRow);
          if (unit && unit.side === enemySide && !unit.isDead) return unit;
        }
      }
    }
    return null;
  }

  // ─── Attack execution ─────────────────────────────────────────────────────

  private performUnitAttack(
    attacker: Unit,
    target: Unit | Building,
    state: GameState,
    attackMult: number,
  ): void {
    const damage = attacker.attack * attackMult;
    target.takeDamage(damage);
    state.pushEvent({
      type:              'unit_attack_hit',
      unitId:            attacker.id,
      targetId:          target.id,
      damage,
      targetHpRemaining: target.hp,
    });

    // Emit building HP update if target is a building
    if (target instanceof Building && !target.isDead) {
      state.pushEvent({
        type:       'building_hp_changed',
        buildingId: target.id,
        hp:         target.hp,
        maxHp:      target.maxHp,
      });
    }
  }

  private performBuildingAttack(
    building: Building,
    target: Unit,
    state: GameState,
    attackMult: number,
  ): void {
    const damage = building.attack * attackMult;
    target.takeDamage(damage);
    state.pushEvent({
      type:              'unit_attack_hit',
      unitId:            building.id,
      targetId:          target.id,
      damage,
      targetHpRemaining: target.hp,
    });
  }
}
