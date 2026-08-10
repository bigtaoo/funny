// Split from CombatSystem.ts (2026-08-10, independent function module range 6).
// The per-tick orchestrator: units attack → towers attack → advance projectiles
// → sweep dead units/buildings. Composes targeting.ts/hitResolution.ts/projectiles.ts
// in the exact original order (attack loops must run before tickProjectiles, which
// must run before dead removal, so same-tick arrow kills are cleaned up like melee).
import { ATTACK_MULT_LATE_GAME, ATTACK_MULT_THRESHOLD_TICKS, BOTTOM_BUILDING_ROW, TOP_BUILDING_ROW } from '../../config';
import { GameState } from '../../GameState';
import { Unit } from '../../Unit';
import { EscortUnit } from '../../EscortUnit';
import { toFp } from '../../math/fixed';
import { Side, UnitState } from '../../types';
import { findTarget, findTargetForBuilding } from './targeting';
import { performBuildingAttack, performUnitAttack } from './hitResolution';
import { tickProjectiles } from './projectiles';

export function runCombatTick(state: GameState): void {
  const board = state.board;

  const attackMult = state.elapsedTicks >= ATTACK_MULT_THRESHOLD_TICKS
    ? ATTACK_MULT_LATE_GAME
    : 1;

  // ── Units attack ───────────────────────────────────────────────────────
  for (const unit of board.units.values()) {
    if (unit.isDead || unit.state === UnitState.Crossing) continue;

    if (unit.attackCooldownTicks > 0) unit.attackCooldownTicks--;

    const target = findTarget(unit, state);
    if (target) {
      const targetId = target instanceof EscortUnit ? target.numericId : target.id;
      if (unit.state !== UnitState.Attacking) {
        state.pushEvent({ type: 'unit_attack_start', unitId: unit.id, targetId });
        unit.targetId = targetId;
        unit.state    = UnitState.Attacking;
      }
      if (unit.attackCooldownTicks === 0) {
        performUnitAttack(unit, target, state, attackMult);
        unit.attackCooldownTicks = unit.effectiveAttackIntervalTicks;
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
      const target = findTargetForBuilding(building, state);
      if (target) {
        performBuildingAttack(building, target, state, attackMult);
        building.attackCooldownTicks = building.attackIntervalTicks;
      }
    }
  }

  // ── Advance projectiles & resolve impacts ────────────────────────────────
  // Runs after both fire loops (so this-tick shots advance once immediately)
  // and before dead removal (so arrow kills are cleaned up in the same tick,
  // identical to melee kills).
  tickProjectiles(state);

  // ── Remove dead units ──────────────────────────────────────────────────
  for (const unit of Array.from(board.units.values())) {
    if (unit.isDead) {
      // Credit kill to the opponent
      const killerOwner = state.ownerOf(unit.side === Side.Bottom ? Side.Top : Side.Bottom);
      state.stats[killerOwner].unitsKilled++;
      // Per-victim-type kill tally (S9-3b) — single removal site covers all killers (melee/arrow/spell).
      const km = state.stats[killerOwner].killsByType;
      km[unit.unitType] = (km[unit.unitType] ?? 0) + 1;

      state.pushEvent({ type: 'unit_died', unitId: unit.id, pos: { col: unit.col, y_fp: unit.y_fp } });

      // onDeathSpawn: spawn minions at the dead unit's position (PvE).
      if (unit.onDeathSpawn) {
        const spawnBp = state.unitBlueprints[unit.onDeathSpawn.type];
        for (let i = 0; i < unit.onDeathSpawn.count; i++) {
          const spawned = new Unit(unit.onDeathSpawn.type, unit.side, unit.col, unit.row, spawnBp, undefined, state.allocUnitId());
          board.addUnit(spawned);
          state.stats[state.ownerOf(unit.side)].unitsSent++;
          const destRow = unit.side === Side.Bottom ? TOP_BUILDING_ROW : BOTTOM_BUILDING_ROW;
          state.pushEvent({
            type:      'unit_spawned',
            unitId:    spawned.id,
            owner:     state.ownerOf(unit.side),
            unitType:  spawned.unitType,
            col:       spawned.col,
            y_fp:      spawned.y_fp,
            radius_fp: spawned.radius_fp,
          });
          state.pushEvent({
            type:     'unit_move_start',
            unitId:   spawned.id,
            from:     { col: spawned.col, y_fp: spawned.y_fp },
            to:       { col: spawned.col, y_fp: toFp(destRow) },
            speed_fp: spawned.speed_fp,
          });
        }
      }

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
