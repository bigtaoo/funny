/**
 * Direct unit coverage for systems/ai/threatAssessment.ts — mostRisingLane (the
 * useThreatMemory rolling-window helper) and freeBuildingLane (used by both the
 * barracks-seeding and arrow-tower defense branches), neither of which was reached by
 * any existing test: no existing scenario runs an L8+ AI far enough to build up 3+
 * threatHistory snapshots with an actual rising lane, and no existing scenario asserts
 * on freeBuildingLane's own return value directly.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Building } from '../Building';
import { Prng } from '../math/prng';
import { ATTACK_LANES, BOARD_COLS, TOP_BUILDING_ROW } from '../config';
import { BuildingType, Side } from '../types';
import { freeBuildingLane, mostRisingLane, chooseOffenseLane } from '../systems/ai/threatAssessment';
import { DIFFICULTY, AiCtx } from '../systems/ai/types';

// ─── freeBuildingLane ────────────────────────────────────────────────────────────────

test('freeBuildingLane (preferSafe=true) picks the least-threatened open lane, skipping occupied ones', () => {
  const state = new GameState(1);
  state.board.addBuilding(new Building(BuildingType.Barracks, Side.Top, ATTACK_LANES[0]!, TOP_BUILDING_ROW));

  const threat = new Array(BOARD_COLS).fill(0);
  for (const lane of ATTACK_LANES) threat[lane] = 5; // baseline so untouched lanes don't win by default
  threat[ATTACK_LANES[0]!] = 0;   // occupied, would otherwise win — must be skipped
  threat[ATTACK_LANES[1]!] = 5;
  threat[ATTACK_LANES[2]!] = 1;   // lowest threat among the open lanes

  const lane = freeBuildingLane(state, threat, /*preferSafe*/ true);
  assert.equal(lane, ATTACK_LANES[2]);
});

test('freeBuildingLane (preferSafe=false) picks the most-threatened open lane', () => {
  const state = new GameState(1);
  const threat = new Array(BOARD_COLS).fill(0);
  threat[ATTACK_LANES[0]!] = 2;
  threat[ATTACK_LANES[1]!] = 9; // heaviest
  threat[ATTACK_LANES[2]!] = 4;

  const lane = freeBuildingLane(state, threat, /*preferSafe*/ false);
  assert.equal(lane, ATTACK_LANES[1]);
});

test('freeBuildingLane returns null once every attack lane already has a building', () => {
  const state = new GameState(1);
  for (const lane of ATTACK_LANES) {
    state.board.addBuilding(new Building(BuildingType.Barracks, Side.Top, lane, TOP_BUILDING_ROW));
  }
  const threat = new Array(BOARD_COLS).fill(0);
  assert.equal(freeBuildingLane(state, threat, true), null);
  assert.equal(freeBuildingLane(state, threat, false), null);
});

// ─── mostRisingLane ──────────────────────────────────────────────────────────────────

test('mostRisingLane returns null with fewer than 3 snapshots', () => {
  assert.equal(mostRisingLane([]), null);
  assert.equal(mostRisingLane([new Array(BOARD_COLS).fill(0)]), null);
  assert.equal(mostRisingLane([new Array(BOARD_COLS).fill(0), new Array(BOARD_COLS).fill(0)]), null);
});

test('mostRisingLane picks the attack lane whose threat climbed the most from oldest to latest', () => {
  const lane0 = ATTACK_LANES[0]!;
  const lane1 = ATTACK_LANES[1]!;
  const oldest = new Array(BOARD_COLS).fill(0);
  const middle = new Array(BOARD_COLS).fill(0);
  const latest = new Array(BOARD_COLS).fill(0);
  oldest[lane0] = 2; latest[lane0] = 5;  // delta 3
  oldest[lane1] = 1; latest[lane1] = 9;  // delta 8 -- the biggest riser

  const lane = mostRisingLane([oldest, middle, latest]);
  assert.equal(lane, lane1);
});

test('mostRisingLane returns null when no attack lane has actually risen (all deltas <= 0)', () => {
  const oldest = new Array(BOARD_COLS).fill(5);
  const middle = new Array(BOARD_COLS).fill(5);
  const latest = new Array(BOARD_COLS).fill(3); // every lane dropped

  assert.equal(mostRisingLane([oldest, middle, latest]), null);
});

// ─── chooseOffenseLane: useThreatMemory branch ──────────────────────────────────────

test('chooseOffenseLane (useThreatMemory=true) returns the rising lane without falling back to pickLane', () => {
  const lane1 = ATTACK_LANES[1]!;
  const oldest = new Array(BOARD_COLS).fill(0);
  const middle = new Array(BOARD_COLS).fill(0);
  const latest = new Array(BOARD_COLS).fill(0);
  latest[lane1] = 7;

  const ctx: AiCtx = {
    params: { ...DIFFICULTY[8]!, useThreatMemory: true },
    rng: new Prng(1),
    threatHistory: [oldest, middle, latest],
  };
  // threat[] itself is deliberately all-zero/irrelevant here — the rising-lane memory
  // must win outright over the plain least-threatened-lane fallback.
  const lane = chooseOffenseLane(ctx, new Array(BOARD_COLS).fill(0));
  assert.equal(lane, lane1);
});

test('chooseOffenseLane (useThreatMemory=true, no rising lane) falls back to pickLane', () => {
  const ctx: AiCtx = {
    params: { ...DIFFICULTY[8]!, useThreatMemory: true },
    rng: new Prng(1),
    threatHistory: [], // fewer than 3 snapshots -> mostRisingLane is null
  };
  const threat = new Array(BOARD_COLS).fill(0);
  threat[ATTACK_LANES[0]!] = 9;
  threat[ATTACK_LANES[1]!] = 0; // least-threatened -> pickLane's fallback pick

  const lane = chooseOffenseLane(ctx, threat);
  assert.equal(lane, ATTACK_LANES[1]);
});
