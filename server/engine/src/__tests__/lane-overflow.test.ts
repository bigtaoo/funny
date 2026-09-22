/**
 * Lane overflow (queue side-step): a unit parked behind friendlies for
 * OVERFLOW_DETOUR_WAIT_TICKS with clear road ahead leaves for the emptier
 * neighbouring lane instead of queueing forever (config.ts "Lane overflow").
 *
 * The geometry these tests lean on: Infantry radius is 0.4, so a stalled queue
 * settles at 0.8-cell spacing. With an enemy at row 12 the queue sits at rows
 * 11.0 / 10.2 / 9.4 / 8.6 / 7.8 — the first three are within
 * OVERFLOW_DETOUR_MIN_ENEMY_GAP (3) of the enemy and hold the line, everything
 * behind them is dead weight and side-steps. That split is the whole point of
 * the feature, so it is asserted directly rather than via "some unit moved".
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { Building } from '../Building';
import { MovementSystem } from '../systems/MovementSystem';
import { OVERFLOW_DETOUR_WAIT_TICKS, TOP_BUILDING_ROW } from '../config';
import { fp, toFp } from '../math/fixed';
import { BuildingType, Side, UnitState, UnitType } from '../types';

/** Bottom-side queue in `col` at the given rows, plus a Top unit at `enemyRow` if given. */
function queuedLane(col: number, rows: number[], enemyRow?: number) {
  const state  = new GameState(1);
  const system = new MovementSystem();

  if (enemyRow !== undefined) {
    const enemy = new Unit(UnitType.Infantry, Side.Top, col, enemyRow);
    enemy.y_fp = toFp(enemyRow);
    enemy.state = UnitState.Attacking; // parked: MovementSystem skips it
    state.board.addUnit(enemy);
  }

  const queue = rows.map((row) => {
    const u = new Unit(UnitType.Infantry, Side.Bottom, col, Math.round(row));
    u.y_fp = fp(Math.round(row * 1000));
    state.board.addUnit(u);
    return u;
  });

  return { state, system, queue };
}

function run(system: MovementSystem, state: GameState, ticks: number): void {
  for (let t = 0; t < ticks; t++) system.tick(state);
}

test('lane overflow: the tail of a stalled queue side-steps, the front ranks hold the line', () => {
  resetUnitIds();
  // Queue behind an enemy at row 12 — see header for the spacing arithmetic.
  const { state, system, queue } = queuedLane(3, [11, 10.2, 9.4, 8.6, 7.8], 12);

  run(system, state, OVERFLOW_DETOUR_WAIT_TICKS + 1);

  // Within 3 rows of the enemy: still queued in lane 3.
  for (const held of [queue[0]!, queue[1]!, queue[2]!]) {
    assert.equal(held.col, 3, 'front ranks must not abandon the line');
    assert.equal(held.state, UnitState.Waiting);
  }
  // Beyond it: gone sideways.
  for (const left of [queue[3]!, queue[4]!]) {
    assert.notEqual(left.state, UnitState.Waiting, 'tail units must stop waiting');
    assert.equal(left.detourDir, 1, 'tie on neighbour counts breaks toward the board centre');
  }
});

test('lane overflow: a unit waiting less than the threshold stays put', () => {
  resetUnitIds();
  const { state, system, queue } = queuedLane(3, [11, 10.2, 9.4, 8.6], 12);

  run(system, state, OVERFLOW_DETOUR_WAIT_TICKS - 1);

  assert.equal(queue[3]!.col, 3);
  assert.equal(queue[3]!.state, UnitState.Waiting);
  assert.equal(queue[3]!.detourTargetCol, null);
});

test('lane overflow: the side-step picks the emptier neighbouring lane', () => {
  resetUnitIds();
  const { state, system, queue } = queuedLane(3, [11, 10.2, 9.4, 8.6], 12);
  // Stack lane 4 so lane 2 becomes the emptier side, overriding the centre tie-break.
  for (let i = 0; i < 3; i++) {
    const filler = new Unit(UnitType.Infantry, Side.Bottom, 4, 3 + i);
    filler.y_fp = toFp(3 + i);
    state.board.addUnit(filler);
  }

  run(system, state, OVERFLOW_DETOUR_WAIT_TICKS + 1);

  assert.equal(queue[3]!.detourDir, -1, 'must head for the emptier lane, not the centre');
});

test('lane overflow: a campaign level that restricts active lanes traps the queue', () => {
  resetUnitIds();
  const { state, system, queue } = queuedLane(3, [11, 10.2, 9.4, 8.6], 12);
  state.board.setActiveLanes([3]);

  run(system, state, OVERFLOW_DETOUR_WAIT_TICKS + 1);

  assert.equal(queue[3]!.col, 3, 'no lane to escape into — the queue stands');
  assert.equal(queue[3]!.state, UnitState.Waiting);
});

test('lane overflow: base columns are never a side-step target', () => {
  resetUnitIds();
  // Lane 4 borders base col 5, so only lane 3 is a legal escape.
  const { state, system, queue } = queuedLane(4, [11, 10.2, 9.4, 8.6], 12);

  run(system, state, OVERFLOW_DETOUR_WAIT_TICKS + 1);

  assert.equal(queue[3]!.detourDir, -1, 'must step away from the base columns');
  assert.notEqual(queue[3]!.detourTargetCol, 5);
});

test('lane overflow: an edge lane side-steps inward only', () => {
  resetUnitIds();
  const { state, system, queue } = queuedLane(0, [11, 10.2, 9.4, 8.6], 12);

  run(system, state, OVERFLOW_DETOUR_WAIT_TICKS + 1);

  assert.equal(queue[3]!.detourDir, 1);
});

test('lane overflow: the wait counter resets as soon as a unit advances again', () => {
  resetUnitIds();
  const { state, system, queue } = queuedLane(3, [11, 10.2], 12);
  const follower = queue[1]!;

  run(system, state, OVERFLOW_DETOUR_WAIT_TICKS - 10);
  assert.ok(follower.waitingTicks > 0, 'precondition: the follower is queued');

  // Clear the lane — the follower advances and the countdown must start over.
  state.board.removeUnit(queue[0]!);
  system.tick(state);

  assert.equal(follower.waitingTicks, 0);
  assert.equal(follower.state, UnitState.Moving);
});

test('lane overflow: a unit queued while Crossing never side-steps', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  // Crossing queues are deliberately outside the side-step's scope: that stretch of road is
  // a few cells long and a unit that stepped sideways there would leave the row it is
  // crossing along. Structurally `tryOverflowDetour` is only reachable from moveForward, so
  // this test's job is to make the trigger condition genuinely hold and show nothing fires.
  //
  // An enemy building one cell ahead is what makes the queue real: the leader stops to
  // attack it (moveCrossing's building branch) and the follower is stuck behind it for far
  // longer than OVERFLOW_DETOUR_WAIT_TICKS. Without the building both units simply walk to
  // the base columns and despawn inside the wait window, and the test proves nothing.
  const blocker = new Building(BuildingType.ArrowTower, Side.Top, 2, TOP_BUILDING_ROW);
  state.board.addBuilding(blocker);

  // Both are parked ON the crossing threshold and left in their default state: moveForward's
  // first act is the threshold check, so the engine flips them to Crossing itself on tick 1.
  // Setting `state` by hand here would also narrow its type to the literal and make the
  // "never Detour" comparison below unreachable as far as tsc is concerned.
  const leader = new Unit(UnitType.Infantry, Side.Bottom, 1, TOP_BUILDING_ROW);
  leader.y_fp = toFp(TOP_BUILDING_ROW);
  leader.x_fp = toFp(1);
  const follower = new Unit(UnitType.Infantry, Side.Bottom, 0, TOP_BUILDING_ROW);
  follower.y_fp = toFp(TOP_BUILDING_ROW);
  follower.x_fp = fp(200); // 0.2 — touching the leader's rear, so it is blocked at once
  state.board.addUnit(leader);
  state.board.addUnit(follower);

  let everDetoured = false;
  for (let t = 0; t < OVERFLOW_DETOUR_WAIT_TICKS + 30; t++) {
    system.tick(state);
    if (leader.state === UnitState.Detour || follower.state === UnitState.Detour) everDetoured = true;
  }

  assert.equal(everDetoured, false, 'the side-step must never fire from the crossing row');
  assert.ok(follower.crossingBlocked, 'precondition: the follower really was stuck behind the leader');
  assert.equal(follower.row, TOP_BUILDING_ROW, 'and it stayed on the row it is crossing along');
  assert.equal(follower.waitingTicks, 0, 'the forward-queue counter has no business running while Crossing');
});
