/**
 * MovementSystem — advances unit positions each tick: forward lane movement, crossing
 * threshold detection, scripted cross-waypoints, BridgeCollapse/blocked-cell auto-detour,
 * friendly-collision blocking, the enemy-ahead clamp (melee "don't walk through" fix), the
 * Detour sub-state machine, and unit_move_start/unit_move_stop event emission. This file
 * drives the real system against real GameState/Board/Unit objects and asserts the
 * resulting position/state/event changes for each branch directly (complementing the
 * higher-level melee_engage.test.ts regression test, which only exercises the combined
 * combat+movement loop).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { Building } from '../Building';
import { MovementSystem } from '../systems/MovementSystem';
import { TOP_BUILDING_ROW, BOTTOM_BUILDING_ROW, BOARD_COLS } from '../config';
import { fp, toFp, mulFp, addFp, subFp, scaleFp, TICK_DT_FP, type Fp } from '../math/fixed';
import { BuildingType, Side, UnitState, UnitType } from '../types';

// ── Crossing threshold ─────────────────────────────────────────────────────────────────────────

test('Bottom unit reaching the top building row flips to Crossing and clamps y_fp exactly to the row', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 4, 16);
  unit.y_fp = toFp(TOP_BUILDING_ROW); // already at (or past) the threshold
  state.board.addUnit(unit);

  system.tick(state);

  assert.equal(unit.state, UnitState.Crossing);
  assert.equal(unit.y_fp, toFp(TOP_BUILDING_ROW));
});

test('Top unit reaching the bottom building row flips to Crossing and clamps y_fp exactly to the row', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Top, 4, 1);
  unit.y_fp = toFp(BOTTOM_BUILDING_ROW);
  state.board.addUnit(unit);

  system.tick(state);

  assert.equal(unit.state, UnitState.Crossing);
  assert.equal(unit.y_fp, toFp(BOTTOM_BUILDING_ROW));
});

// ── Cross-waypoint trigger ─────────────────────────────────────────────────────────────────────

test('cross-waypoint: triggers a lane-switch Detour once the unit reaches atRow, consuming the waypoint', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 4, 5);
  unit.pendingWaypoints = [{ atRow: 5, toCol: 6 }]; // unit.row (5) >= atRow (5) -> triggers now
  state.board.addUnit(unit);

  system.tick(state);

  assert.equal(unit.pendingWaypoints.length, 0, 'the waypoint must be consumed once triggered');
  assert.equal(unit.state, UnitState.Detour);
  assert.equal(unit.detourTargetCol, 6);
  assert.equal(unit.detourDir, 1, 'toCol (6) > current col (4) -> detour direction is +1');
});

test('cross-waypoint: not yet triggered (row hasn\'t reached atRow) leaves the waypoint pending and moves normally', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 4, 3);
  unit.pendingWaypoints = [{ atRow: 5, toCol: 6 }]; // unit.row (3) < atRow (5) -> not yet
  state.board.addUnit(unit);

  system.tick(state);

  assert.equal(unit.pendingWaypoints.length, 1, 'waypoint must remain pending');
  assert.notEqual(unit.state, UnitState.Detour);
});

test('cross-waypoint: triggering into the SAME column consumes the waypoint but does not enter Detour', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 4, 5);
  unit.pendingWaypoints = [{ atRow: 5, toCol: 4 }]; // toCol === current col
  state.board.addUnit(unit);

  system.tick(state);

  assert.equal(unit.pendingWaypoints.length, 0);
  assert.notEqual(unit.state, UnitState.Detour, 'no column change needed, so no Detour — movement falls through to normal advance');
});

// ── BridgeCollapse column block ────────────────────────────────────────────────────────────────

test('tempBlockedCols: forces Detour, defaulting detourDir toward the board center for a left-side column', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 2, 5); // col 2 < 5.5 -> default dir +1
  state.board.addUnit(unit);
  state.tempBlockedCols.set(2, 999);

  system.tick(state);

  assert.equal(unit.state, UnitState.Detour);
  assert.equal(unit.detourDir, 1);
  assert.equal(unit.detourTargetCol, 3);
});

test('tempBlockedCols: forces Detour, defaulting detourDir toward the board center for a right-side column', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 9, 5); // col 9 >= 5.5 -> default dir -1
  state.board.addUnit(unit);
  state.tempBlockedCols.set(9, 999);

  system.tick(state);

  assert.equal(unit.state, UnitState.Detour);
  assert.equal(unit.detourDir, -1);
  assert.equal(unit.detourTargetCol, 8);
});

test('tempBlockedCols: an already-assigned detourDir is preserved, not recomputed from the column', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 2, 5); // col 2 < 5.5 would default to +1...
  unit.detourDir = -1; // ...but a direction is already assigned, so it must stick.
  state.board.addUnit(unit);
  state.tempBlockedCols.set(2, 999);

  system.tick(state);

  assert.equal(unit.detourDir, -1);
  assert.equal(unit.detourTargetCol, 1);
});

// ── Blocked-cell auto-detour ───────────────────────────────────────────────────────────────────

test('a blocked cell directly ahead triggers auto-detour for a ground unit', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 4, 5);
  state.board.addUnit(unit);
  state.board.setBlocked([{ col: 4, row: 6 }]); // next row in Bottom's direction of travel

  system.tick(state);

  assert.equal(unit.state, UnitState.Detour);
});

test('flying units bypass blocked-cell auto-detour entirely', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Harpy, Side.Bottom, 4, 5); // Harpy is flying
  assert.ok(unit.flying);
  state.board.addUnit(unit);
  state.board.setBlocked([{ col: 4, row: 6 }]);

  system.tick(state);

  assert.notEqual(unit.state, UnitState.Detour, 'a flying unit must never be routed into Detour by a blocked ground cell');
});

// ── Friendly-collision blocking ────────────────────────────────────────────────────────────────

test('friendly collision: a unit right behind another snaps to exactly one radius-pair behind it and waits', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const front = new Unit(UnitType.Infantry, Side.Bottom, 4, 6);
  const back  = new Unit(UnitType.Infantry, Side.Bottom, 4, 6);
  // Units are processed in Map insertion order, so `front` (unobstructed) advances by its own
  // step BEFORE `back`'s collision check runs this same tick — place `back` exactly touching
  // where `front` will be AFTER its own advance, not where `front` starts.
  const frontYAfterOwnAdvance = addFp(front.y_fp, mulFp(front.speed_fp, TICK_DT_FP));
  back.y_fp = subFp(subFp(frontYAfterOwnAdvance, front.radius_fp), back.radius_fp);
  state.board.addUnit(front);
  state.board.addUnit(back);

  system.tick(state);

  assert.equal(front.y_fp, frontYAfterOwnAdvance, 'sanity: front was unobstructed and advanced exactly one step');
  assert.equal(back.state, UnitState.Waiting);
  assert.equal(back.y_fp, subFp(subFp(front.y_fp, front.radius_fp), back.radius_fp), 'snapped to exactly one footprint behind the front unit');
});

test('friendly collision: once Waiting, a unit needs a full 2x-radius gap before resuming (no Moving/Waiting flapping)', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const front = new Unit(UnitType.Infantry, Side.Bottom, 4, 8);
  const back  = new Unit(UnitType.Infantry, Side.Bottom, 4, 6);
  back.state = UnitState.Waiting;
  // gapFp = (front.y - front.r) - (back.y + back.r), measured against front's position AFTER
  // its own (unobstructed) advance this tick. Choose a small positive gap, well under
  // 2*radius, so the "already waiting" rule keeps it waiting.
  const frontYAfterOwnAdvance = addFp(front.y_fp, mulFp(front.speed_fp, TICK_DT_FP));
  const smallGap = subFp(scaleFp(2, back.radius_fp), toFp(0.1)) as Fp; // < 2*radius
  back.y_fp = subFp(subFp(subFp(frontYAfterOwnAdvance, front.radius_fp), smallGap), back.radius_fp);
  state.board.addUnit(front);
  state.board.addUnit(back);

  system.tick(state);

  assert.equal(back.state, UnitState.Waiting, 'gap under 2*radius must not let a Waiting unit resume');
});

test('friendly collision: a Waiting unit resumes Moving once the gap widens past 2x radius', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const front = new Unit(UnitType.Infantry, Side.Bottom, 4, 12);
  const back  = new Unit(UnitType.Infantry, Side.Bottom, 4, 2);
  back.state = UnitState.Waiting; // far away — gap is huge, well past 2*radius
  state.board.addUnit(front);
  state.board.addUnit(back);

  system.tick(state);

  assert.notEqual(back.state, UnitState.Waiting, 'ample room ahead must let a previously-Waiting unit resume advancing');
});

// ── Normal advance ─────────────────────────────────────────────────────────────────────────────

test('normal advance: an unobstructed unit moves forward by speed_fp*TICK_DT_FP and flips to Moving', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 4, 5);
  unit.y_fp = toFp(5);
  state.board.addUnit(unit);

  const dy: Fp = mulFp(unit.speed_fp, TICK_DT_FP);
  const expectedY = addFp(unit.y_fp, dy);

  system.tick(state);

  assert.equal(unit.y_fp, expectedY);
  assert.equal(unit.state, UnitState.Moving);
});

// ── Enemy-ahead clamp (melee "don't walk through" fix) ────────────────────────────────────────

test('enemy-ahead clamp: a Bottom unit is held back so it never advances within one cell of an enemy ahead', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit  = new Unit(UnitType.Infantry, Side.Bottom, 4, 5);
  const enemy = new Unit(UnitType.Infantry, Side.Top, 4, 6); // exactly 1 cell ahead
  unit.y_fp  = toFp(5);
  enemy.y_fp = toFp(6);
  state.board.addUnit(unit);
  state.board.addUnit(enemy);

  system.tick(state);

  assert.equal(unit.y_fp, toFp(5), 'clamped to stay exactly 1 cell behind the enemy, so no visible advance this tick');
  assert.equal(unit.state, UnitState.Waiting);
});

test('enemy-ahead clamp: a Top unit is held back so it never advances within one cell of an enemy ahead', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit  = new Unit(UnitType.Infantry, Side.Top, 4, 6);
  const enemy = new Unit(UnitType.Infantry, Side.Bottom, 4, 5); // exactly 1 cell ahead (toward lower y)
  unit.y_fp  = toFp(6);
  enemy.y_fp = toFp(5);
  state.board.addUnit(unit);
  state.board.addUnit(enemy);

  system.tick(state);

  assert.equal(unit.y_fp, toFp(6));
  assert.equal(unit.state, UnitState.Waiting);
});

// ── Attacking units are skipped entirely ──────────────────────────────────────────────────────

test('a unit in the Attacking state is skipped by MovementSystem entirely', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 4, 5);
  unit.y_fp  = toFp(5);
  unit.state = UnitState.Attacking;
  state.board.addUnit(unit);

  system.tick(state);

  assert.equal(unit.y_fp, toFp(5), 'an Attacking unit must not move');
  assert.equal(unit.state, UnitState.Attacking);
});

// ── unit_move_stop event emission ──────────────────────────────────────────────────────────────

test('unit_move_stop fires when a Moving unit transitions to Waiting (blocked by a friendly ahead)', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const front = new Unit(UnitType.Infantry, Side.Bottom, 4, 6);
  const back  = new Unit(UnitType.Infantry, Side.Bottom, 4, 6);
  // See the "friendly collision" test above: place `back` touching where `front` will be
  // AFTER its own (unobstructed) advance this same tick, since Map iteration processes
  // `front` first.
  const frontYAfterOwnAdvance = addFp(front.y_fp, mulFp(front.speed_fp, TICK_DT_FP));
  back.y_fp = subFp(subFp(frontYAfterOwnAdvance, front.radius_fp), back.radius_fp);
  assert.equal(back.state, UnitState.Moving, 'sanity: unit starts Moving');
  state.board.addUnit(front);
  state.board.addUnit(back);

  system.tick(state);

  assert.equal(back.state, UnitState.Waiting);
  const stopEvents = state.events.filter((e) => e.type === 'unit_move_stop');
  assert.equal(stopEvents.length, 1);
  assert.equal((stopEvents[0] as { unitId: number }).unitId, back.id);
});

// ── Detour sub-state machine ───────────────────────────────────────────────────────────────────

test('moveDetour: a null detourTargetCol immediately resets the unit to Moving', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 4, 5);
  unit.state = UnitState.Detour;
  unit.detourTargetCol = null;
  state.board.addUnit(unit);

  system.tick(state);

  assert.equal(unit.state, UnitState.Moving);
});

test('moveDetour: dir +1 advances laterally, clamps at the target column, and resumes Moving on a clear arrival', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 3, 5);
  unit.state = UnitState.Detour;
  unit.detourDir = 1;
  unit.detourTargetCol = 5;
  state.board.addUnit(unit);

  let arrived = false;
  for (let i = 0; i < 200 && !arrived; i++) {
    system.tick(state);
    assert.ok(unit.x_fp <= toFp(5), `x_fp must never overshoot the target column (got ${unit.x_fp})`);
    if (unit.detourTargetCol === null) arrived = true;
  }

  assert.ok(arrived, 'unit should have arrived at the target column within 200 ticks');
  assert.equal(unit.col, 5);
  assert.equal(unit.state, UnitState.Moving, 'a clear path ahead must resume forward movement');
  assert.equal(unit.detourDir, 1, 'direction is kept (not reset) so the unit doesn\'t immediately re-detour');
});

test('moveDetour: dir -1 advances laterally, clamps at the target column, and resumes Moving on a clear arrival', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 6, 5);
  unit.state = UnitState.Detour;
  unit.detourDir = -1;
  unit.detourTargetCol = 4;
  state.board.addUnit(unit);

  let arrived = false;
  for (let i = 0; i < 200 && !arrived; i++) {
    system.tick(state);
    assert.ok(unit.x_fp >= toFp(4), `x_fp must never overshoot the target column (got ${unit.x_fp})`);
    if (unit.detourTargetCol === null) arrived = true;
  }

  assert.ok(arrived);
  assert.equal(unit.col, 4);
  assert.equal(unit.state, UnitState.Moving);
});

test('moveDetour: on arrival, a still-blocked forward cell extends the detour by one more column in the same direction', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 3, 5); // Bottom -> nextRow = row+1 = 6
  unit.state = UnitState.Detour;
  unit.detourDir = 1;
  unit.detourTargetCol = 4;
  // Position just 1fp short of the target so this single tick's dx clamps exactly onto it,
  // and the arrival branch runs in this same tick.
  unit.x_fp = subFp(toFp(4), fp(1));
  state.board.addUnit(unit);
  state.board.setBlocked([{ col: 4, row: 6 }]); // forward cell from the arrival point is blocked

  system.tick(state);

  assert.equal(unit.col, 4, 'unit reached the original target column this tick');
  assert.equal(unit.state, UnitState.Detour, 'still blocked ahead -> stays in Detour');
  assert.equal(unit.detourTargetCol, 5, 'detour extends one more column in the same (+1) direction');
});

test('moveDetour: extending past the board edge reverses the detour direction instead of going out of bounds', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const lastCol = BOARD_COLS - 1;
  const unit = new Unit(UnitType.Infantry, Side.Bottom, lastCol - 1, 5);
  unit.state = UnitState.Detour;
  unit.detourDir = 1;
  unit.detourTargetCol = lastCol;
  unit.x_fp = subFp(toFp(lastCol), fp(1));
  state.board.addUnit(unit);
  state.board.setBlocked([{ col: lastCol, row: 6 }]); // still blocked -> would extend past the edge

  system.tick(state);

  assert.equal(unit.col, lastCol);
  assert.equal(unit.detourDir, -1, 'extending past BOARD_COLS must reverse direction');
  assert.equal(unit.detourTargetCol, lastCol - 1, 'new target is one column back, in the reversed direction');
});

// ── Dead-unit sweep ────────────────────────────────────────────────────────────────────────────

test('a unit that died earlier this tick (e.g. in CombatSystem) is swept off the board by the post-move cleanup pass', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const alive = new Unit(UnitType.Infantry, Side.Bottom, 2, 5);
  const dying = new Unit(UnitType.Infantry, Side.Top, 8, 5);
  dying.hp_fp = toFp(0); // simulate CombatSystem having killed it earlier this same tick
  state.board.addUnit(alive);
  state.board.addUnit(dying);

  assert.ok(state.board.units.has(dying.id), 'sanity: the dead unit is still present before MovementSystem runs');

  system.tick(state);

  assert.ok(!state.board.units.has(dying.id), 'a dead unit must be swept off the board');
  assert.ok(!state.board.isCellOccupiedByUnit(dying.col, dying.row), 'the dead unit\'s cell must be cleared too');
  assert.ok(state.board.units.has(alive.id), 'a living unit must be unaffected by the sweep');
});

// ── predictStopY: enemy building ahead (unit_move_start prediction) ───────────────────────────

test('predictStopY: a Bottom unit starting to move factors an enemy building ahead into its predicted stop point', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Bottom, 4, 5);
  unit.state = UnitState.Waiting; // not currently Moving -> a transition to Moving fires unit_move_start
  state.board.addUnit(unit);

  const enemyBuilding = new Building(BuildingType.ArrowTower, Side.Top, 4, TOP_BUILDING_ROW);
  state.board.addBuilding(enemyBuilding);

  system.tick(state);

  assert.equal(unit.state, UnitState.Moving, 'sanity: nothing blocks this unit, so it starts moving this tick');
  const startEvent = state.events.find((e) => e.type === 'unit_move_start') as
    { to: { y_fp: number } } | undefined;
  assert.ok(startEvent, 'unit_move_start must fire on the Waiting -> Moving transition');

  const rangeFp = toFp(unit.effectiveRange);
  const expectedStopY = subFp(toFp(TOP_BUILDING_ROW), rangeFp);
  assert.equal(startEvent!.to.y_fp, expectedStopY, 'predicted stop point must back off from the enemy building by the unit\'s range');
});

test('predictStopY: a Top unit starting to move factors an enemy building ahead into its predicted stop point', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const system = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Top, 4, 12);
  unit.state = UnitState.Waiting;
  state.board.addUnit(unit);

  const enemyBuilding = new Building(BuildingType.ArrowTower, Side.Bottom, 4, BOTTOM_BUILDING_ROW);
  state.board.addBuilding(enemyBuilding);

  system.tick(state);

  assert.equal(unit.state, UnitState.Moving);
  const startEvent = state.events.find((e) => e.type === 'unit_move_start') as
    { to: { y_fp: number } } | undefined;
  assert.ok(startEvent);

  const rangeFp = toFp(unit.effectiveRange);
  const expectedStopY = addFp(toFp(BOTTOM_BUILDING_ROW), rangeFp);
  assert.equal(startEvent!.to.y_fp, expectedStopY);
});

