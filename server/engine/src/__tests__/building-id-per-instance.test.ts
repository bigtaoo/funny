/**
 * Regression: building id allocation must be PER GameState instance, never a shared module global.
 *
 * Identical class of bug to unit ids (see unit-id-per-instance.test.ts), on the building side.
 * Building ids came from a module-level counter that `new GameState()` reset back to 0. During a
 * ranked netplay match, judgeRunner builds a *second* GameState mid-match to recompute a disputed
 * state hash — resetting that shared counter. The live engine's next building placement (a player
 * dropping an Arrow Tower) then reused a still-live id, and because `Board.buildings` is a
 * `Map<id, Building>`, `addBuilding` OVERWROTE the older building in the map. The orphaned building
 * vanished from `board.buildings` (which BuildingProductionSystem / CombatSystem iterate) but stayed
 * stamped in `buildingGrid`, so it stopped being ticked yet kept occupying its cell — an invisible
 * "ghost" building. These tests pin the building-id counter to the GameState instance.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Building, resetBuildingIds } from '../Building';
import { BuildingType, Side } from '../types';

test('allocBuildingId is monotonic and starts at 0 for a fresh match', () => {
  const gs = new GameState(1);
  assert.equal(gs.allocBuildingId(), 0);
  assert.equal(gs.allocBuildingId(), 1);
  assert.equal(gs.allocBuildingId(), 2);
});

test('constructing a second GameState mid-match does NOT perturb the first match\'s building-id stream', () => {
  const gsA = new GameState(1);
  assert.equal(gsA.allocBuildingId(), 0);
  assert.equal(gsA.allocBuildingId(), 1);

  // Simulate judgeRunner's mid-match hash recompute: a brand-new engine/state.
  // Under the old module-global counter this reset the shared id back to 0.
  const gsB = new GameState(2);
  assert.equal(gsB.allocBuildingId(), 0); // gsB has its OWN counter, independent of gsA
  gsB.allocBuildingId();
  gsB.allocBuildingId();

  // gsA must keep counting from where it left off — NOT restart at 0.
  assert.equal(gsA.allocBuildingId(), 2, 'first match building-id stream was reset by a second GameState');
  assert.equal(gsA.allocBuildingId(), 3);
});

test('board.buildings never loses a live building to an id collision after a mid-match second GameState', () => {
  const gsA = new GameState(1);

  const b1 = new Building(BuildingType.ArrowTower, Side.Bottom, 3, 1, undefined, gsA.allocBuildingId());
  gsA.board.addBuilding(b1);

  // Mid-match judge recompute builds a second state (old bug: reset the shared counter).
  new GameState(2);

  const b2 = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 1, undefined, gsA.allocBuildingId());
  gsA.board.addBuilding(b2);

  assert.notEqual(b1.id, b2.id, 'second placement reused the first building\'s id (would clobber the Map)');
  assert.equal(gsA.board.buildings.size, 2, 'a live building was clobbered out of board.buildings (ghost)');
  assert.equal(gsA.board.buildings.get(b1.id), b1, 'first building was overwritten by the id-colliding placement');
  assert.equal(gsA.board.buildings.get(b2.id), b2);
  // The orphaned ghost would also linger in buildingGrid at its old cell — both cells stay live here.
  assert.equal(gsA.board.getBuildingAt(3, 1), b1);
  assert.equal(gsA.board.getBuildingAt(5, 1), b2);
});

test('end-to-end: a match keeps placing distinct buildings across a mid-match second engine (no ghost)', () => {
  const gsA = new GameState(1);

  const place = (state: GameState, col: number, row: number): Building => {
    const b = new Building(BuildingType.ArrowTower, state === gsA ? Side.Bottom : Side.Top, col, row, undefined, state.allocBuildingId());
    state.board.addBuilding(b);
    return b;
  };

  place(gsA, 2, 1);
  place(gsA, 3, 1);
  const afterFirstBurst = gsA.board.buildings.size;
  assert.equal(afterFirstBurst, 2, 'buildings were not placed');

  // judgeRunner-style mid-match recompute: a second engine is built and even places its own
  // buildings. Under the old global counter this reset the id source shared with gsA.
  const gsB = new GameState(2);
  place(gsB, 2, 1);
  place(gsB, 3, 1);

  // gsA keeps placing — none of these may collide with the buildings already on gsA's board.
  place(gsA, 4, 1);
  place(gsA, 5, 1);

  const ids = [...gsA.board.buildings.values()].map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate building ids on the board → a building was clobbered into a ghost');
  assert.equal(gsA.board.buildings.size, afterFirstBurst + 2, 'later placements overwrote earlier live buildings');
});

test('standalone Building fallback ids never collide with per-instance ids', () => {
  resetBuildingIds();
  const standalone = new Building(BuildingType.ArrowTower, Side.Bottom, 0, 0);
  // Fallback range sits above the per-instance range but still <1000, so mixing standalone and
  // engine-placed buildings on one board can never collide, and buildings never reach the unit
  // range (≥1000).
  assert.ok(standalone.id >= 500 && standalone.id < 1000, `standalone fallback id ${standalone.id} is outside the building fallback range`);

  const gs = new GameState(1);
  assert.equal(gs.allocBuildingId(), 0); // instance counter unaffected by the module fallback
});
