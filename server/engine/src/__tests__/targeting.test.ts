/**
 * Target acquisition edge cases (findTarget / findTargetForBuilding, §4.9.3 escort
 * targeting). Existing tests exercise findTarget only through full CombatSystem.tick()
 * runs (melee_engage, ghost_untargetable) with plain unit-vs-unit boards; this file
 * isolates the escort-targeting branches unique to findTarget — Top-side-only escort
 * eligibility, escort-vs-unit ring priority, and the building fallback — by calling
 * findTarget/findTargetForBuilding directly.
 *
 * Imported from '../systems/CombatSystem' (the re-export shell), not the combat/
 * targeting submodule, so the barrel's forwarding exports get direct function-coverage
 * credit too.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { Building, resetBuildingIds } from '../Building';
import { EscortUnit } from '../EscortUnit';
import type { EscortSpec } from '../campaign/LevelDefinition';
import { findTarget, findTargetForBuilding } from '../systems/CombatSystem';
import { UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '../config';
import { BuildingType, Side, UnitType } from '../types';

test('findTarget: a Top-side unit can target a moving escort when no enemy unit/building is closer', () => {
  resetUnitIds();
  const state = new GameState(1);
  const attacker = new Unit(UnitType.Infantry, Side.Top, 5, 10, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(attacker);
  const spec: EscortSpec = { id: 'esc1', hp: 50, speed: 1, startCol: 5, startRow: 9 }; // Chebyshev dist 1
  const escort = new EscortUnit(spec);
  state.escorts.push(escort);

  assert.equal(findTarget(attacker, state), escort);
});

test('findTarget: a Bottom-side unit never targets escorts (movingEscorts is empty for Bottom)', () => {
  resetUnitIds();
  const state = new GameState(2);
  const attacker = new Unit(UnitType.Infantry, Side.Bottom, 5, 10, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(attacker);
  const spec: EscortSpec = { id: 'esc2', hp: 50, speed: 1, startCol: 5, startRow: 9 };
  const escort = new EscortUnit(spec);
  state.escorts.push(escort);

  assert.equal(findTarget(attacker, state), null, 'Bottom-side attacker ignores escorts entirely');
});

test('findTarget: falls back to an enemy building when no enemy unit or escort is in range', () => {
  resetUnitIds();
  resetBuildingIds();
  const state = new GameState(3);
  const attacker = new Unit(UnitType.Infantry, Side.Top, 5, 10, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(attacker);
  const building = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 9, BUILDING_BLUEPRINTS[BuildingType.ArrowTower]);
  state.board.addBuilding(building);

  assert.equal(findTarget(attacker, state), building);
});

test('findTarget: an enemy unit at the same ring takes priority over an escort', () => {
  resetUnitIds();
  const state = new GameState(4);
  const attacker = new Unit(UnitType.Infantry, Side.Top, 5, 10, UNIT_BLUEPRINTS[UnitType.Infantry]);
  state.board.addUnit(attacker);
  const enemyUnit = new Unit(UnitType.Infantry, Side.Bottom, 6, 9, UNIT_BLUEPRINTS[UnitType.Infantry]); // dist 1
  state.board.addUnit(enemyUnit);
  const spec: EscortSpec = { id: 'esc3', hp: 50, speed: 1, startCol: 5, startRow: 9 }; // dist 1
  const escort = new EscortUnit(spec);
  state.escorts.push(escort);

  assert.equal(findTarget(attacker, state), enemyUnit, 'a real enemy unit beats an escort at the same ring');
});

test('findTarget: an escort claimed at a closer ring is not later displaced by a farther enemy building', () => {
  resetUnitIds();
  resetBuildingIds();
  const state = new GameState(5);
  const attacker = new Unit(UnitType.Infantry, Side.Top, 5, 10, UNIT_BLUEPRINTS[UnitType.Infantry]);
  attacker.rangeMod = 1; // effectiveRange 2 so both rings get scanned
  state.board.addUnit(attacker);
  const spec: EscortSpec = { id: 'esc4', hp: 50, speed: 1, startCol: 5, startRow: 9 }; // dist 1
  const escort = new EscortUnit(spec);
  state.escorts.push(escort);
  const building = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 8, BUILDING_BLUEPRINTS[BuildingType.ArrowTower]); // dist 2
  state.board.addBuilding(building);

  assert.equal(
    findTarget(attacker, state),
    escort,
    'the closer escort keeps priority once claimed — a farther building never overrides it',
  );
});

// ── findTargetForBuilding (barrel re-export coverage) ───────────────────────

test('findTargetForBuilding: finds the nearest enemy unit within range, ring by ring', () => {
  resetUnitIds();
  resetBuildingIds();
  const state = new GameState(6);
  const tower = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 3, BUILDING_BLUEPRINTS[BuildingType.ArrowTower]);
  state.board.addBuilding(tower);
  const nearEnemy = new Unit(UnitType.Infantry, Side.Top, 5, 4, UNIT_BLUEPRINTS[UnitType.Infantry]); // dist 1
  const farEnemy  = new Unit(UnitType.Infantry, Side.Top, 5, 5, UNIT_BLUEPRINTS[UnitType.Infantry]); // dist 2
  state.board.addUnit(nearEnemy);
  state.board.addUnit(farEnemy);

  assert.equal(findTargetForBuilding(tower, state), nearEnemy);
});

test('findTargetForBuilding: returns null when nothing enemy is within range', () => {
  resetBuildingIds();
  const state = new GameState(7);
  const tower = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 3, BUILDING_BLUEPRINTS[BuildingType.ArrowTower]);
  state.board.addBuilding(tower);

  assert.equal(findTargetForBuilding(tower, state), null);
});
