/**
 * EscortSystem — advances friendly escort units toward the enemy base each tick (§4.9.3).
 * Previously zero functional coverage: only VFX-id string checks existed. This file drives the
 * real system against a real GameState/EscortUnit for several ticks and asserts the resulting
 * position/status/event changes.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { EscortUnit, resetEscortIds } from '../EscortUnit';
import { EscortSystem } from '../systems/EscortSystem';
import { TOP_BUILDING_ROW } from '../config';
import { toFp, mulFp, TICK_DT_FP } from '../math/fixed';
import type { EscortSpec } from '../campaign/LevelDefinition';

test('normal advance: row_fp advances by speed_fp*TICK_DT_FP each tick and emits escort_moved', () => {
  resetEscortIds();
  const state = new GameState(1);
  const system = new EscortSystem();

  const spec: EscortSpec = { id: 'e1', hp: 100, speed: 1, startCol: 3, startRow: 5 };
  const escort = new EscortUnit(spec, state.allocEscortId());
  state.escorts.push(escort);

  const startRow_fp = escort.row_fp;
  const stepFp = mulFp(escort.speed_fp, TICK_DT_FP);

  system.tick(state);

  assert.equal(escort.row_fp, startRow_fp + stepFp, 'row_fp should advance by speed_fp*TICK_DT_FP');
  assert.equal(escort.col_fp, toFp(3), 'col_fp stays put with no waypoints');
  assert.equal(escort.status, 'moving');

  const moved = state.events.find((e) => e.type === 'escort_moved');
  assert.ok(moved, 'escort_moved should be pushed');
  assert.equal((moved as { escortId: string }).escortId, 'e1');
  assert.equal((moved as { row_fp: number }).row_fp, escort.row_fp);
  assert.equal((moved as { col_fp: number }).col_fp, escort.col_fp);

  // A second tick keeps advancing by the same fixed step.
  system.tick(state);
  assert.equal(escort.row_fp, startRow_fp + stepFp * 2);
});

test('waypoint snap: col_fp snaps to the waypoint once row_fp reaches it, and the waypoint is consumed', () => {
  resetEscortIds();
  const state = new GameState(1);
  const system = new EscortSystem();

  const spec: EscortSpec = {
    id: 'e2', hp: 100, speed: 1, startCol: 2, startRow: 5,
    path: [{ col: 8, row: 6 }],
  };
  const escort = new EscortUnit(spec, state.allocEscortId());
  state.escorts.push(escort);

  const initialPathLength = escort.remainingPath.length;
  assert.equal(initialPathLength, 1, 'sanity: waypoint present before ticking');

  const wpRow_fp = toFp(6);
  let snapped = false;
  for (let i = 0; i < 60 && !snapped; i++) {
    system.tick(state);
    if (escort.remainingPath.length === 0) snapped = true;
  }

  assert.ok(snapped, 'escort should have reached and consumed the waypoint within 60 ticks');
  assert.equal(escort.row_fp, wpRow_fp, 'row_fp should snap exactly to the waypoint row, not overshoot');
  assert.equal(escort.col_fp, toFp(8), 'col_fp should snap to the waypoint col');
});

test('arrival: row_fp clamps to arrivalRow_fp, status flips to arrived, escort_arrived fires (not escort_moved), and the escort then stops advancing', () => {
  resetEscortIds();
  const state = new GameState(1);
  const system = new EscortSystem();

  // speed=40 -> step_fp = mulFp(toFp(40), TICK_DT_FP) = trunc(40000*33/1000) = 1320.
  // From row 16 (row_fp=16000), one tick overshoots arrivalRow_fp = toFp(17) = 17000.
  const spec: EscortSpec = { id: 'e3', hp: 100, speed: 40, startCol: 4, startRow: 16 };
  const escort = new EscortUnit(spec, state.allocEscortId());
  state.escorts.push(escort);

  const arrivalRow_fp = toFp(TOP_BUILDING_ROW);
  system.tick(state);

  assert.equal(escort.status, 'arrived');
  assert.equal(escort.row_fp, arrivalRow_fp, 'row_fp should be clamped exactly to arrivalRow_fp, not left overshot');

  const movedEvents = state.events.filter((e) => e.type === 'escort_moved');
  const arrivedEvents = state.events.filter((e) => e.type === 'escort_arrived');
  assert.equal(movedEvents.length, 0, 'no escort_moved should fire on the arrival tick');
  assert.equal(arrivedEvents.length, 1);
  assert.equal((arrivedEvents[0] as { escortId: string }).escortId, 'e3');

  // status !== 'moving' now -> subsequent ticks must skip this escort entirely.
  state.clearEvents();
  const rowBefore = escort.row_fp;
  system.tick(state);
  assert.equal(escort.row_fp, rowBefore, 'an arrived escort must not be advanced further');
  assert.equal(state.events.length, 0, 'an arrived escort must not emit further events');
});

test('death: hp<=0 flips status to dead and emits escort_died once; a dead escort is never advanced again', () => {
  resetEscortIds();
  const state = new GameState(1);
  const system = new EscortSystem();

  const spec: EscortSpec = { id: 'e4', hp: 100, speed: 1, startCol: 1, startRow: 5 };
  const escort = new EscortUnit(spec, state.allocEscortId());
  escort.hp_fp = toFp(0); // simulate CombatSystem having already dropped hp to 0 earlier this tick
  state.escorts.push(escort);

  const rowBefore = escort.row_fp;
  system.tick(state);

  assert.equal(escort.status, 'dead');
  assert.equal(escort.row_fp, rowBefore, 'a dying escort must not advance on the tick it dies');
  const diedEvents = state.events.filter((e) => e.type === 'escort_died');
  assert.equal(diedEvents.length, 1);
  assert.equal((diedEvents[0] as { escortId: string }).escortId, 'e4');

  // status !== 'moving' now -> subsequent ticks must skip this escort entirely.
  state.clearEvents();
  system.tick(state);
  assert.equal(escort.row_fp, rowBefore, 'a dead escort must never move');
  assert.equal(state.events.length, 0, 'a dead escort must not emit further events');
});
