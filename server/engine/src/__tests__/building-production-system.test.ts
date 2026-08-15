/**
 * BuildingProductionSystem — barracks produce units on a tick-based cooldown. Lines were
 * already 100% covered, but branch coverage was only 80%: the "not a Barracks" skip, the
 * "dead Barracks" skip, and both sides of the spawnCooldownTicks>0 / ===0 checks were not all
 * independently exercised. This file drives the real system against a real GameState/Board/
 * Building and asserts the resulting board/stats/event changes directly.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Building } from '../Building';
import { BuildingProductionSystem } from '../systems/BuildingProductionSystem';
import { BARRACKS_SPAWN_INTERVAL_TICKS, BOTTOM_SPAWN_ROW, TOP_SPAWN_ROW } from '../config';
import { toFp } from '../math/fixed';
import { BuildingType, Side, UnitType } from '../types';

test('a non-Barracks building (ArrowTower) is skipped entirely, even with spawnCooldownTicks === 0', () => {
  const state  = new GameState(1);
  const system = new BuildingProductionSystem();

  const tower = new Building(BuildingType.ArrowTower, Side.Bottom, 3, 1);
  assert.equal(tower.spawnCooldownTicks, 0);
  state.board.addBuilding(tower);

  system.tick(state);

  assert.equal(state.board.units.size, 0, 'ArrowTower must never spawn units');
  assert.equal(state.events.length, 0);
});

test('a dead Barracks is skipped and never spawns, regardless of its cooldown', () => {
  const state  = new GameState(1);
  const system = new BuildingProductionSystem();

  const barracks = new Building(BuildingType.Barracks, Side.Bottom, 3, 1);
  barracks.hp_fp = toFp(0); // isDead === true
  assert.equal(barracks.spawnCooldownTicks, 0, 'sanity: cooldown alone would otherwise trigger a spawn');
  state.board.addBuilding(barracks);

  system.tick(state);

  assert.equal(state.board.units.size, 0, 'a destroyed barracks must not spawn');
  assert.equal(state.events.length, 0);
});

test('spawnCooldownTicks > 0 only decrements — no spawn this tick', () => {
  const state  = new GameState(1);
  const system = new BuildingProductionSystem();

  const barracks = new Building(BuildingType.Barracks, Side.Bottom, 3, 1);
  barracks.spawnCooldownTicks = 5;
  state.board.addBuilding(barracks);

  system.tick(state);

  assert.equal(barracks.spawnCooldownTicks, 4);
  assert.equal(state.board.units.size, 0, 'no spawn while the cooldown is still above 0 after decrementing');
});

test('spawnCooldownTicks reaching exactly 0 after decrementing spawns a unit and resets the cooldown', () => {
  const state  = new GameState(1);
  const system = new BuildingProductionSystem();

  const barracks = new Building(BuildingType.Barracks, Side.Bottom, 3, 1);
  barracks.spawnCooldownTicks = 1; // decrements to 0 THIS tick -> spawn fires in the same tick
  state.board.addBuilding(barracks);

  system.tick(state);

  assert.equal(barracks.spawnCooldownTicks, BARRACKS_SPAWN_INTERVAL_TICKS, 'cooldown resets before the next interval');
  assert.equal(state.board.units.size, 1);

  const [unit] = [...state.board.units.values()];
  assert.equal(unit!.side, Side.Bottom);
  assert.equal(unit!.col, barracks.col);
  assert.equal(unit!.row, BOTTOM_SPAWN_ROW, 'Bottom-side barracks spawn at BOTTOM_SPAWN_ROW');

  assert.equal(state.stats[state.ownerOf(Side.Bottom)].unitsSent, 1);

  const spawnedEvent = state.events.find((e) => e.type === 'building_spawned_unit');
  const unitSpawnedEvent = state.events.find((e) => e.type === 'unit_spawned');
  assert.ok(spawnedEvent, 'building_spawned_unit event must fire');
  assert.ok(unitSpawnedEvent, 'unit_spawned event must fire');
  assert.equal((spawnedEvent as { buildingId: number }).buildingId, barracks.id);
  assert.equal((unitSpawnedEvent as { unitType: UnitType }).unitType, unit!.unitType);
});

test('a fresh barracks (spawnCooldownTicks defaults to 0) spawns immediately on its very first tick, without decrementing first', () => {
  const state  = new GameState(1);
  const system = new BuildingProductionSystem();

  const barracks = new Building(BuildingType.Barracks, Side.Top, 5, 16);
  assert.equal(barracks.spawnCooldownTicks, 0);
  state.board.addBuilding(barracks);

  system.tick(state);

  assert.equal(state.board.units.size, 1, 'spawnCooldownTicks === 0 must spawn on the very first tick');
  const [unit] = [...state.board.units.values()];
  assert.equal(unit!.side, Side.Top);
  assert.equal(unit!.row, TOP_SPAWN_ROW, 'Top-side barracks spawn at TOP_SPAWN_ROW');
  assert.equal(barracks.spawnCooldownTicks, BARRACKS_SPAWN_INTERVAL_TICKS);
});

test('multiple barracks on the board are each ticked independently in the same pass', () => {
  const state  = new GameState(1);
  const system = new BuildingProductionSystem();

  const ready = new Building(BuildingType.Barracks, Side.Bottom, 2, 1); // cooldown 0 -> spawns
  const notReady = new Building(BuildingType.Barracks, Side.Bottom, 8, 1);
  notReady.spawnCooldownTicks = 50; // far from ready
  state.board.addBuilding(ready);
  state.board.addBuilding(notReady);

  system.tick(state);

  assert.equal(state.board.units.size, 1, 'only the ready barracks should have spawned');
  assert.equal(notReady.spawnCooldownTicks, 49);
});
