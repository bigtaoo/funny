/**
 * `MovementSystem.ts`'s last branch gaps, all of them the mirror image of a case that already
 * exists: a detour running LEFT rather than right, a TOP-side unit arriving at its detour
 * target, the board-edge reversal from the left edge, and the crossing collision scan looking
 * leftward / stepping over a corpse.
 *
 * Left-vs-right and Bottom-vs-Top are the two axes this file is mirrored along, and a sign
 * error on either is the classic form of movement bug here: it does not throw, it makes units
 * walk the wrong way. In particular the edge reversal is the only thing that stops a unit
 * detouring off the board — `newTarget = targetCol + dir` at col 0 with dir −1 is column −1,
 * and `unit.col` would then index outside the lane grid every tick for the rest of the match.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { MovementSystem } from '../systems/MovementSystem';
import { BASE_COLS, TOP_BUILDING_ROW } from '../config';
import { fp, toFp } from '../math/fixed';
import { Side, UnitState, UnitType } from '../types';

// ── Detour, leftward and Top-side ───────────────────────────────────────────────────────────

test('a leftward detour clamps to its target col instead of overshooting it', () => {
  resetUnitIds();
  const state = new GameState(1);
  const ms = new MovementSystem();

  // Placed a fraction of a cell to the right of col 0 and detouring left: one tick of lateral
  // speed is more than the remaining distance, so the clamp is the only thing keeping x_fp from
  // going negative (which rounds to col 0 anyway — and then silently keeps drifting).
  const unit = new Unit(UnitType.Infantry, Side.Bottom, 0, 8);
  unit.x_fp = fp(10);
  unit.state = UnitState.Detour;
  unit.detourTargetCol = 0;
  unit.detourDir = -1;
  state.board.addUnit(unit);

  ms.tick(state);
  assert.equal(unit.x_fp, toFp(0), 'clamped exactly onto the target col, not past it');
  assert.equal(unit.col, 0);
});

test('a Top-side unit arriving at its detour col checks the row AHEAD OF IT (row-1), not row+1', () => {
  resetUnitIds();
  const state = new GameState(1);
  const ms = new MovementSystem();

  // Top advances toward row 0, so "forward" from row 8 is row 7. Blocking row 9 instead (which
  // is forward for a Bottom unit) must NOT keep the detour going.
  const unit = new Unit(UnitType.Infantry, Side.Top, 0, 8);
  unit.x_fp = fp(10);
  unit.state = UnitState.Detour;
  unit.detourTargetCol = 0;
  unit.detourDir = -1;
  state.board.addUnit(unit);
  state.board.setBlocked([{ col: 0, row: 9 }]);

  ms.tick(state);
  assert.equal(unit.detourTargetCol, null, 'row 9 is behind a Top unit — the path ahead is clear');
  assert.equal(unit.state, UnitState.Moving);
});

test('a detour that reaches the left board edge reverses direction instead of walking off it', () => {
  resetUnitIds();
  const state = new GameState(1);
  const ms = new MovementSystem();

  const unit = new Unit(UnitType.Infantry, Side.Top, 0, 8);
  unit.x_fp = fp(10);
  unit.state = UnitState.Detour;
  unit.detourTargetCol = 0;
  unit.detourDir = -1;
  state.board.addUnit(unit);
  // Forward (row 7 for a Top unit) is still blocked at col 0, so the detour wants to extend by
  // another column in the same direction — which would be col -1.
  state.board.setBlocked([{ col: 0, row: 7 }]);

  ms.tick(state);
  assert.equal(unit.detourDir, 1, 'reversed at the edge');
  assert.equal(unit.detourTargetCol, 1, 'and re-aimed back into the board, never at col -1');
  assert.equal(unit.state, UnitState.Detour, 'still detouring — the path ahead has not opened');
});

// ── Crossing collision scan, leftward and past a corpse ─────────────────────────────────────

test('the crossing collision scan looks LEFT for a unit crossing from the right side', () => {
  resetUnitIds();
  const state = new GameState(1);
  const ms = new MovementSystem();
  const [baseMin, baseMax] = BASE_COLS;

  // Both units are right of the base columns, so they cross leftward (toward col 6). "Ahead"
  // therefore means SMALLER x — the arm that a rightward-crossing test never reaches.
  const behind = new Unit(UnitType.Infantry, Side.Bottom, 9, TOP_BUILDING_ROW);
  const ahead = new Unit(UnitType.Infantry, Side.Bottom, 7, TOP_BUILDING_ROW);
  for (const u of [behind, ahead]) {
    u.state = UnitState.Crossing;
    state.board.addUnit(u);
  }
  assert.ok(behind.x_fp > toFp(baseMax), 'test premise: crossing right-to-left');

  const startX = behind.x_fp;
  ms.tick(state);
  assert.ok(behind.x_fp < startX, 'it advanced leftward, toward the base');
  assert.ok(behind.x_fp > ahead.x_fp, 'and never passed through the friend in front of it');
  assert.ok(ahead.x_fp >= toFp(baseMin), 'the front unit is the one that reaches the base first');
});

test('the crossing collision scan looks RIGHT for a unit crossing from the left side', () => {
  resetUnitIds();
  const state = new GameState(1);
  const ms = new MovementSystem();
  const [baseMin] = BASE_COLS;

  // The mirror of the case above: left of the base columns, so "ahead" means LARGER x.
  const behind = new Unit(UnitType.Infantry, Side.Bottom, 1, TOP_BUILDING_ROW);
  const ahead = new Unit(UnitType.Infantry, Side.Bottom, 3, TOP_BUILDING_ROW);
  for (const u of [behind, ahead]) {
    u.state = UnitState.Crossing;
    state.board.addUnit(u);
  }
  assert.ok(behind.x_fp < toFp(baseMin), 'test premise: crossing left-to-right');

  const startX = behind.x_fp;
  ms.tick(state);
  assert.ok(behind.x_fp > startX, 'it advanced rightward, toward the base');
  assert.ok(behind.x_fp < ahead.x_fp, 'and never passed through the friend in front of it');
});

test('the crossing collision scan steps over a friendly corpse that has not been swept yet', () => {
  resetUnitIds();
  const state = new GameState(1);
  const ms = new MovementSystem();

  // A unit killed earlier this tick is still in the board map until MovementSystem's sweep at
  // the end of tick(). If the scan counted it, the unit behind would brake for a body — and,
  // because a corpse never moves, stay braked until the sweep, i.e. flap between Waiting and
  // Moving every tick while the crossing queue backs up behind it.
  const behind = new Unit(UnitType.Infantry, Side.Bottom, 9, TOP_BUILDING_ROW);
  const corpse = new Unit(UnitType.Infantry, Side.Bottom, 8, TOP_BUILDING_ROW);
  for (const u of [behind, corpse]) {
    u.state = UnitState.Crossing;
    state.board.addUnit(u);
  }
  corpse.hp_fp = fp(0);
  assert.equal(corpse.isDead, true);

  const startX = behind.x_fp;
  ms.tick(state);
  assert.ok(behind.x_fp < startX, 'the live unit kept crossing');
  assert.equal(behind.crossingBlocked, false, 'a corpse is not a blocker');
  assert.equal(state.board.units.has(corpse.id), false, 'and the corpse was swept at end of tick');
});
