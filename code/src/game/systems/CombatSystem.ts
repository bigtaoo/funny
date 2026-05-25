import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { Building } from '../Building';
import { Side, UnitState } from '../types';

export class CombatSystem {
  tick(state: GameState, dt: number): void {
    const board = state.board;

    // Units attack
    for (const unit of board.units.values()) {
      if (unit.isDead || unit.state === UnitState.Crossing) continue;

      unit.attackCooldown = Math.max(0, unit.attackCooldown - dt);

      const target = this.findTarget(unit, state);
      if (target) {
        unit.state = UnitState.Attacking;
        if (unit.attackCooldown <= 0) {
          this.performAttack(unit, target, state);
          unit.attackCooldown = unit.attackInterval;
        }
      } else if (unit.state === UnitState.Attacking) {
        unit.state = UnitState.Moving;
      }
    }

    // Arrow towers attack
    for (const building of board.buildings.values()) {
      if (building.isDead || !building.isDefender) continue;

      building.attackCooldown = Math.max(0, building.attackCooldown - dt);
      if (building.attackCooldown <= 0) {
        const target = this.findTargetForBuilding(building, state);
        if (target) {
          this.performBuildingAttack(building, target, state);
          building.attackCooldown = building.attackInterval;
        }
      }
    }

    // Remove dead units and buildings
    for (const unit of Array.from(board.units.values())) {
      if (unit.isDead) {
        state.pushEvent({ type: 'unit_died', unitId: unit.id });
        board.removeUnit(unit);
      }
    }
    for (const building of Array.from(board.buildings.values())) {
      if (building.isDead) {
        state.pushEvent({ type: 'building_destroyed', buildingId: building.id });
        board.removeBuilding(building);
      }
    }
  }

  private findTarget(unit: Unit, state: GameState): Unit | Building | null {
    const board = state.board;
    const direction = unit.side === Side.Bottom ? -1 : 1;

    for (let dist = 1; dist <= unit.range; dist++) {
      const checkRow = Math.round(unit.row) + direction * dist;
      if (checkRow < 0 || checkRow >= 20) break;

      // Check enemy units
      const enemy = board.getUnitAt(unit.col, checkRow);
      if (enemy && enemy.side !== unit.side && !enemy.isDead) return enemy;

      // Check enemy buildings
      const building = board.getBuildingAt(unit.col, checkRow);
      if (building && building.side !== unit.side && !building.isDead) return building;
    }
    return null;
  }

  private findTargetForBuilding(building: Building, state: GameState): Unit | null {
    const board = state.board;
    const enemySide = building.side === Side.Bottom ? Side.Top : Side.Bottom;
    const direction = building.side === Side.Bottom ? -1 : 1; // tower attacks toward enemy

    for (let dist = 1; dist <= building.attackRange; dist++) {
      const checkRow = building.row + direction * dist;
      const unit = board.getUnitAt(building.col, checkRow);
      if (unit && unit.side === enemySide && !unit.isDead) return unit;
    }
    return null;
  }

  private performAttack(attacker: Unit, target: Unit | Building, state: GameState): void {
    if (target instanceof Unit) {
      target.takeDamage(attacker.attack);
      state.pushEvent({
        type: 'unit_attacked',
        attackerId: attacker.id,
        targetId: target.id,
        damage: attacker.attack,
      });
    } else {
      target.takeDamage(attacker.attack);
      state.pushEvent({
        type: 'building_attacked',
        attackerId: attacker.id,
        buildingId: target.id,
        damage: attacker.attack,
      });
    }
  }

  private performBuildingAttack(building: Building, target: Unit, state: GameState): void {
    target.takeDamage(building.attack);
    state.pushEvent({
      type: 'unit_attacked',
      attackerId: building.id,
      targetId: target.id,
      damage: building.attack,
    });
  }
}
