import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { Building } from '../Building';
import { Side, UnitState } from '../types';

/**
 * CombatSystem — tick-based attack cooldowns, no floating-point.
 *
 * Each tick:
 *   1. Decrement all cooldowns by 1 tick.
 *   2. Find targets for attacking units and arrow towers.
 *   3. Execute attacks when cooldown reaches 0.
 *   4. Emit unit_died / building_destroyed events and remove dead entities.
 */
export class CombatSystem {
  tick(state: GameState): void {
    const board = state.board;

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
          this.performUnitAttack(unit, target, state);
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
          this.performBuildingAttack(building, target, state);
          building.attackCooldownTicks = building.attackIntervalTicks;
        }
      }
    }

    // ── Remove dead units ──────────────────────────────────────────────────
    for (const unit of Array.from(board.units.values())) {
      if (unit.isDead) {
        state.pushEvent({ type: 'unit_died', unitId: unit.id, pos: { col: unit.col, y_fp: unit.y_fp } });
        board.removeUnit(unit);
      }
    }

    // ── Remove destroyed buildings ─────────────────────────────────────────
    for (const building of Array.from(board.buildings.values())) {
      if (building.isDead) {
        state.pushEvent({ type: 'building_destroyed', buildingId: building.id, pos: building.pos });
        board.removeBuilding(building);
      }
    }
  }

  // ─── Target finding ───────────────────────────────────────────────────────

  private findTarget(unit: Unit, state: GameState): Unit | Building | null {
    const board     = state.board;
    const direction = unit.side === Side.Bottom ? -1 : 1;

    for (let dist = 1; dist <= unit.range; dist++) {
      const checkRow = unit.row + direction * dist;
      if (checkRow < 0 || checkRow >= 20) break;

      const enemy = board.getUnitAt(unit.col, checkRow);
      if (enemy && enemy.side !== unit.side && !enemy.isDead) return enemy;

      const building = board.getBuildingAt(unit.col, checkRow);
      if (building && building.side !== unit.side && !building.isDead) return building;
    }
    return null;
  }

  private findTargetForBuilding(building: Building, state: GameState): Unit | null {
    const board     = state.board;
    const direction = building.side === Side.Bottom ? -1 : 1;
    const enemySide = building.side === Side.Bottom ? Side.Top : Side.Bottom;

    for (let dist = 1; dist <= building.attackRange; dist++) {
      const checkRow = building.row + direction * dist;
      const unit     = board.getUnitAt(building.col, checkRow);
      if (unit && unit.side === enemySide && !unit.isDead) return unit;
    }
    return null;
  }

  // ─── Attack execution ─────────────────────────────────────────────────────

  private performUnitAttack(attacker: Unit, target: Unit | Building, state: GameState): void {
    target.takeDamage(attacker.attack);
    state.pushEvent({
      type:              'unit_attack_hit',
      unitId:            attacker.id,
      targetId:          target.id,
      damage:            attacker.attack,
      targetHpRemaining: target.hp,
    });
  }

  private performBuildingAttack(building: Building, target: Unit, state: GameState): void {
    target.takeDamage(building.attack);
    state.pushEvent({
      type:              'unit_attack_hit',
      unitId:            building.id,
      targetId:          target.id,
      damage:            building.attack,
      targetHpRemaining: target.hp,
    });
  }
}
