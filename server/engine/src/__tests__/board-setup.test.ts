/**
 * Direct unit coverage for engine/setup/board.ts's applyBoardSetup — the
 * cellMask/activeLanes/hazards/startInk/inkRegenMult/laneLength board-shaping step run
 * once at PvE/siege match construction (see buildCtx.ts). goldenReplay scenarios already
 * exercise laneLength end-to-end through a full engine run, but startInk and
 * inkRegenMult had no direct coverage at all, and none of the "field omitted / empty
 * array" falsy branches were probed in isolation — this file closes those gaps.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { applyBoardSetup } from '../engine/setup/board';
import { BOARD_ROWS, TOP_SPAWN_ROW } from '../config';
import type { LevelDefinition } from '../campaign/LevelDefinition';

/** Minimal valid LevelDefinition; only the fields applyBoardSetup reads are ever overridden. */
function baseLevel(overrides: Partial<LevelDefinition> = {}): LevelDefinition {
  return {
    id: 'test_level',
    chapter: 0,
    seed: 1,
    objective: { kind: 'survive' },
    waves: { entries: [] },
    ...overrides,
  };
}

test('applyBoardSetup: a level with no board shaping at all leaves the board/state at defaults', () => {
  const state = new GameState(1);
  applyBoardSetup(state, baseLevel());
  assert.deepEqual(state.board.getBlockedCells(), []);
  assert.deepEqual(state.board.getNoBuildCells(), []);
  assert.equal(state.board.getActiveLanes(), undefined);
  assert.deepEqual(state.hazards, []);
  assert.equal(state.bottomPlayer.ink, 0);
  assert.equal(state.bottomInkRegenMult, 1);
});

test('applyBoardSetup: empty blocked/noBuild/activeLanes/hazards arrays are treated as absent (falsy-length branch)', () => {
  const state = new GameState(2);
  applyBoardSetup(state, baseLevel({
    board: { cellMask: { blocked: [], noBuild: [] }, activeLanes: [] },
    hazards: [],
  }));
  assert.deepEqual(state.board.getBlockedCells(), []);
  assert.deepEqual(state.board.getNoBuildCells(), []);
  assert.equal(state.board.getActiveLanes(), undefined);
  assert.deepEqual(state.hazards, []);
});

test('applyBoardSetup: non-empty blocked/noBuild/activeLanes/hazards are applied verbatim', () => {
  const state = new GameState(3);
  const blocked = [{ col: 1, row: 2 }];
  const noBuild = [{ col: 3, row: 4 }];
  const activeLanes = [0, 1];
  const hazards = [{ col: 0, rowRange: [0, 5] as [number, number], effect: 'lava' as const }];
  applyBoardSetup(state, baseLevel({ board: { cellMask: { blocked, noBuild }, activeLanes }, hazards }));
  assert.deepEqual(state.board.getBlockedCells(), blocked);
  assert.deepEqual(state.board.getNoBuildCells(), noBuild);
  assert.deepEqual(state.board.getActiveLanes(), activeLanes);
  assert.equal(state.hazards, hazards, 'hazards array is assigned by reference');
});

test('applyBoardSetup: startInk adds ink to the bottom player only (top player untouched)', () => {
  const state = new GameState(4);
  applyBoardSetup(state, baseLevel({ startInk: 5 }));
  assert.equal(state.bottomPlayer.ink, 5);
  assert.equal(state.topPlayer.ink, 0);
});

test('applyBoardSetup: startInk of exactly 0 is falsy and does NOT call addInkFp (if-truthy, not if-defined)', () => {
  const state = new GameState(5);
  applyBoardSetup(state, baseLevel({ startInk: 0 }));
  assert.equal(state.bottomPlayer.ink, 0);
});

test('applyBoardSetup: startInk omitted leaves ink at 0', () => {
  const state = new GameState(6);
  applyBoardSetup(state, baseLevel());
  assert.equal(state.bottomPlayer.ink, 0);
});

test('applyBoardSetup: inkRegenMult overrides bottomInkRegenMult, including an explicit 0 (uses !== undefined, not truthiness)', () => {
  const half = new GameState(7);
  applyBoardSetup(half, baseLevel({ inkRegenMult: 0.5 }));
  assert.equal(half.bottomInkRegenMult, 0.5);

  const zero = new GameState(8);
  applyBoardSetup(zero, baseLevel({ inkRegenMult: 0 }));
  assert.equal(zero.bottomInkRegenMult, 0, 'explicit 0 must still override the default 1');
});

test('applyBoardSetup: inkRegenMult omitted leaves the GameState default of 1', () => {
  const state = new GameState(9);
  applyBoardSetup(state, baseLevel());
  assert.equal(state.bottomInkRegenMult, 1);
});

test('applyBoardSetup: laneLength truncates a lane, blocking every row above the new spawn row', () => {
  const state = new GameState(10);
  const col = 3;
  const len = 5; // spawnRow = BOARD_ROWS(18) - 5 = 13
  applyBoardSetup(state, baseLevel({ board: { laneLength: { [col]: len } } }));

  const spawnRow = BOARD_ROWS - len;
  const expectedRows: number[] = [];
  for (let row = spawnRow + 1; row <= TOP_SPAWN_ROW; row++) expectedRows.push(row);

  const blocked = state.board.getBlockedCells();
  assert.equal(blocked.length, expectedRows.length);
  for (const row of expectedRows) {
    assert.ok(blocked.some((c) => c.col === col && c.row === row), `row ${row} on col ${col} should be blocked`);
  }
});

test('applyBoardSetup: laneLength across multiple columns blocks each column independently', () => {
  const state = new GameState(11);
  applyBoardSetup(state, baseLevel({ board: { laneLength: { 2: 17, 9: 5 } } }));
  const blocked = state.board.getBlockedCells();
  assert.ok(blocked.some((c) => c.col === 2 && c.row === 2), 'col 2 (len 17) should block row 2');
  assert.ok(blocked.some((c) => c.col === 9 && c.row === 14), 'col 9 (len 5) should block row 14');
});

test('applyBoardSetup: laneLength merges with existing cellMask.blocked cells rather than replacing them', () => {
  const state = new GameState(12);
  const existingBlocked = [{ col: 8, row: 8 }];
  applyBoardSetup(state, baseLevel({
    board: { cellMask: { blocked: existingBlocked }, laneLength: { 2: 17 } }, // spawnRow=1 -> blocks rows 2..16 (15 rows)
  }));
  const blocked = state.board.getBlockedCells();
  assert.ok(blocked.some((c) => c.col === 8 && c.row === 8), 'original cellMask.blocked cell must survive the merge');
  assert.ok(blocked.some((c) => c.col === 2 && c.row === 16), 'laneLength-derived blocked cell must be present');
  assert.equal(blocked.length, 1 + (TOP_SPAWN_ROW - (BOARD_ROWS - 17)));
});

test('applyBoardSetup: laneLength yielding zero rows-to-block does not call setBlocked (branch coverage for the length>0 guard)', () => {
  const state = new GameState(13);
  // len=2 -> spawnRow = BOARD_ROWS(18) - 2 = 16 -> loop runs row=17..16, i.e. never -> laneLengthBlocked stays empty.
  applyBoardSetup(state, baseLevel({ board: { laneLength: { 4: 2 } } }));
  assert.deepEqual(state.board.getBlockedCells(), []);
});

test('applyBoardSetup: laneLength omitted leaves blocked cells untouched', () => {
  const state = new GameState(14);
  applyBoardSetup(state, baseLevel());
  assert.deepEqual(state.board.getBlockedCells(), []);
});
