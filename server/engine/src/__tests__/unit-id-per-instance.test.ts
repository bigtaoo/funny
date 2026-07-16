/**
 * Regression: unit id allocation must be PER GameState instance, never a shared module global.
 *
 * The live bug (confirmed 2026-07-16 from a shared PvP replay): unit ids came from a module-level
 * counter that `new GameState()` reset back to 1000. During a ranked netplay match, judgeRunner
 * builds a *second* GameState mid-match to recompute a disputed state hash — resetting that shared
 * counter. The live engine's next barracks spawn then reused a still-live id, and because
 * `Board.units` is a `Map<id, Unit>`, `addUnit` OVERWROTE the older unit in the map. The orphaned
 * unit stayed in `columnUnits` (collision list) but was gone from `board.units`, so MovementSystem
 * — which iterates `board.units.values()` — never moved, fought, or removed it. Result: an invisible
 * frozen "ghost" that blocked its lane forever, piling up the units spawned behind it (all `waiting`,
 * nothing visibly ahead). These tests pin the id counter to the GameState instance.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { Building } from '../Building';
import { BuildingProductionSystem } from '../systems/BuildingProductionSystem';
import { BuildingType, Side, UnitType } from '../types';

test('allocUnitId is monotonic and starts at 1000 for a fresh match', () => {
  const gs = new GameState(1);
  assert.equal(gs.allocUnitId(), 1000);
  assert.equal(gs.allocUnitId(), 1001);
  assert.equal(gs.allocUnitId(), 1002);
});

test('constructing a second GameState mid-match does NOT perturb the first match\'s id stream', () => {
  const gsA = new GameState(1);
  assert.equal(gsA.allocUnitId(), 1000);
  assert.equal(gsA.allocUnitId(), 1001);

  // Simulate judgeRunner's mid-match hash recompute: a brand-new engine/state.
  // Under the old module-global counter this reset the shared id back to 1000.
  const gsB = new GameState(2);
  assert.equal(gsB.allocUnitId(), 1000); // gsB has its OWN counter, independent of gsA
  gsB.allocUnitId();
  gsB.allocUnitId();

  // gsA must keep counting from where it left off — NOT restart at 1000.
  assert.equal(gsA.allocUnitId(), 1002, 'first match id stream was reset by a second GameState');
  assert.equal(gsA.allocUnitId(), 1003);
});

test('board.units never loses a live unit to an id collision after a mid-match second GameState', () => {
  const gsA = new GameState(1);

  const u1 = new Unit(UnitType.Infantry, Side.Bottom, 3, 5, undefined, undefined, gsA.allocUnitId());
  gsA.board.addUnit(u1);

  // Mid-match judge recompute builds a second state (old bug: reset the shared counter).
  new GameState(2);

  const u2 = new Unit(UnitType.Infantry, Side.Bottom, 3, 6, undefined, undefined, gsA.allocUnitId());
  gsA.board.addUnit(u2);

  assert.notEqual(u1.id, u2.id, 'second spawn reused the first unit\'s id (would clobber the Map)');
  assert.equal(gsA.board.units.size, 2, 'a live unit was clobbered out of board.units (ghost)');
  assert.equal(gsA.board.units.get(u1.id), u1, 'first unit was overwritten by the id-colliding spawn');
  assert.equal(gsA.board.units.get(u2.id), u2);
});

test('end-to-end: barracks keeps spawning distinct units across a mid-match second engine (no ghost blocker)', () => {
  const gsA = new GameState(1);
  const production = new BuildingProductionSystem();

  const barracks = new Building(BuildingType.Barracks, Side.Bottom, 3, 1);
  gsA.board.addBuilding(barracks);

  const spawnOnce = (state: GameState) => {
    barracks.spawnCooldownTicks = 0; // force a spawn this tick
    production.tick(state);
  };

  spawnOnce(gsA);
  spawnOnce(gsA);
  const afterFirstBurst = gsA.board.units.size;
  assert.ok(afterFirstBurst >= 2, 'barracks did not spawn units');

  // judgeRunner-style mid-match recompute: a second engine is built and even runs its own
  // barracks. Under the old global counter this reset the id source shared with gsA.
  const gsB = new GameState(2);
  const barracksB = new Building(BuildingType.Barracks, Side.Bottom, 3, 1);
  gsB.board.addBuilding(barracksB);
  barracksB.spawnCooldownTicks = 0;
  new BuildingProductionSystem().tick(gsB);

  // gsA keeps spawning — none of these may collide with the units already on gsA's board.
  spawnOnce(gsA);
  spawnOnce(gsA);

  const ids = [...gsA.board.units.values()].map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate unit ids on the board → a unit was clobbered into a ghost');
  assert.equal(gsA.board.units.size, afterFirstBurst + 2, 'later spawns overwrote earlier live units');
});

test('standalone Unit fallback ids never collide with per-instance ids', () => {
  resetUnitIds();
  const standalone = new Unit(UnitType.Infantry, Side.Bottom, 0, 1);
  // Fallback range is far above the per-instance range (≥1000), so mixing standalone and
  // engine-spawned units on one board (as some tests do) can never collide.
  assert.ok(standalone.id >= 900_000, `standalone fallback id ${standalone.id} is inside the per-instance range`);

  const gs = new GameState(1);
  assert.equal(gs.allocUnitId(), 1000); // instance counter unaffected by the module fallback
});
