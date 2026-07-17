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
import { Unit } from '../Unit';
import { createGameEngine } from '../GameEngine';
import { ATTACK_LANES } from '../config';
import { toFp } from '../math/fixed';
import { BuildingType, CardType, Side, UnitType } from '../types';
import type { GameConfig, GameEvent, PlayerCommand } from '../types';
import type { LevelDefinition } from '../campaign/LevelDefinition';

/** Play `step(0)` on a fresh engine, retrying seeds until the bottom opening hand holds a building card. */
function engineWithBuildingCard(): { engine: ReturnType<typeof createGameEngine>; slotIndex: number } {
  for (let seed = 1; seed < 500; seed++) {
    const engine = createGameEngine({ seed, players: [{ id: 0 }, { id: 1 }] });
    engine.step(0, []);
    const slotIndex = engine.state.bottomPlayer.hand.slots.findIndex(
      (s) => s?.card.cardType === CardType.Building,
    );
    if (slotIndex >= 0) return { engine, slotIndex };
  }
  throw new Error('no seed < 500 dealt an opening hand containing a building card');
}

/** Id of the first `building_placed` event in a batch, or undefined. The `.type` guard narrows the union. */
function placedBuildingId(events: readonly GameEvent[]): number | undefined {
  for (const e of events) if (e.type === 'building_placed') return e.buildingId;
  return undefined;
}

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

test('integration: placing a building via the play_card command path draws its id from GameState.allocBuildingId', () => {
  const { engine, slotIndex } = engineWithBuildingCard();
  // Grant ink so the affordability guard doesn't skip the play (setup only).
  engine.state.bottomPlayer.addInkFp(toFp(9999));

  const cmd: PlayerCommand = { type: 'play_card', owner: 0, tick: 1, handIndex: slotIndex, col: ATTACK_LANES[0] };
  const events = engine.step(1, [cmd]);

  const id = placedBuildingId(events);
  assert.notEqual(id, undefined, 'building_placed event fired for the played building card');
  // Per-instance counter starts at 0; the module fallback is >=500. If commands.ts stopped
  // passing state.allocBuildingId() (the wiring this fix adds), the placement would fall back
  // to the module counter and this id would be >=500 — so <500 pins the wiring.
  assert.ok(id! < 500, `placed building id ${id} came from the module fallback, not GameState.allocBuildingId`);
  assert.equal(engine.state.board.buildings.get(id!)?.id, id, 'placed building is retrievable from board.buildings by its event id');
});

test('integration: defenderBuildings (engine/base.ts) get per-instance ids, starting at 0', () => {
  const level: LevelDefinition = {
    id: 'test_defender_buildings',
    chapter: 0,
    seed: 7,
    objective: { kind: 'timed_defense', durationTicks: 5 },
    waves: { entries: [] },
    defenderBuildings: [
      { buildingType: BuildingType.ArrowTower, col: ATTACK_LANES[0] },
      { buildingType: BuildingType.ArrowTower, col: ATTACK_LANES[1] },
    ],
  };
  const config: GameConfig = { seed: 7, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level };
  const engine = createGameEngine(config);
  engine.step(0, []);

  const ids = [...engine.state.board.buildings.keys()].sort((a, b) => a - b);
  assert.equal(ids.length, 2, 'both defender buildings landed on the board');
  // Freshly built engine → instance counter runs 0, 1. A dropped allocBuildingId() wiring in
  // base.ts would instead hand out module-fallback ids (>=500).
  assert.deepEqual(ids, [0, 1], `defender buildings did not use the per-instance counter (got ${ids})`);
});

test('unit and building id namespaces never overlap on the same live board', () => {
  const gs = new GameState(1);
  // Interleave real placements + spawns exactly as a live match would, all through the
  // per-instance counters, then assert the two id ranges stay disjoint.
  for (let i = 0; i < 3; i++) {
    gs.board.addBuilding(new Building(BuildingType.ArrowTower, Side.Bottom, i, 1, undefined, gs.allocBuildingId()));
    gs.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, i, 5, undefined, undefined, gs.allocUnitId()));
  }

  const buildingIds = [...gs.board.buildings.keys()];
  const unitIds = [...gs.board.units.keys()];
  for (const bid of buildingIds) assert.ok(bid < 1000, `building id ${bid} bled into the unit range (>=1000)`);
  for (const uid of unitIds) assert.ok(uid >= 1000, `unit id ${uid} bled into the building range (<1000)`);

  const overlap = buildingIds.filter((id) => unitIds.includes(id));
  assert.deepEqual(overlap, [], `id collision across the unit/building namespaces: ${overlap}`);
});
