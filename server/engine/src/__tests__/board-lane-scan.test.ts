/**
 * `Board.ts`'s three lane scans — `getFrontUnitInLane`, `getFriendlyUnitAhead`,
 * `getEnemyUnitAhead` — driven through the filters each one applies, not just their happy path.
 *
 * The happy paths were already covered (MovementSystem drives all three every tick). What had
 * never run were the SKIP arms: a corpse still sitting in the column list, a flyer next to a
 * ground unit, a flyer in front of a melee unit that cannot hit it, and "the whole lane is
 * empty" on both directions of `getFrontUnitInLane`.
 *
 * Each skip is a filter with a visible failure mode if it inverts:
 *   · corpse not skipped → units stop and mill in front of a dead body (the `state === Dead`
 *     arm exists because `isDead` alone is not enough: a unit is marked Dead for a few ticks
 *     before it leaves the board),
 *   · flying mismatch not skipped → a ground unit collides with the harpy flying over it, i.e.
 *     the lane silently jams,
 *   · untargetable flyer not skipped → a melee unit stops one cell short of a harpy it cannot
 *     hit and stands there for the rest of the match (this is `getEnemyUnitAhead`'s reason to
 *     mirror findTarget's filter — the two must agree or a unit stops for a target it will
 *     never engage).
 * None of these throws, and all three leave the sim advancing normally, so a unit test is the
 * only place they get noticed.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Board } from '../Board';
import { UNIT_BLUEPRINTS } from '../config';
import { Unit } from '../Unit';
import { fp } from '../math/fixed';
import { Side, UnitState, UnitType } from '../types';

/** A unit of `type` pinned to an exact fp row in `col`. */
function unitAt(type: UnitType, side: Side, col: number, row: number): Unit {
  const u = new Unit(type, side, col, row);
  u.y_fp = fp(row * 1000);
  return u;
}

/** Kill `u` the way combat does: hp to 0 AND the Dead state marker. */
function kill(u: Unit): Unit {
  u.hp_fp = fp(0);
  u.state = UnitState.Dead;
  return u;
}

// Sanity-check the blueprint facts the cases below lean on, so a re-tune that gives Infantry
// canTargetFlying (or grounds the Harpy) fails here with a clear message instead of silently
// turning these tests into no-ops.
test('blueprint preconditions: Harpy flies, Infantry cannot hit flyers, Archer can', () => {
  assert.equal(UNIT_BLUEPRINTS[UnitType.Harpy].flying, true);
  assert.notEqual(UNIT_BLUEPRINTS[UnitType.Infantry].flying, true);
  assert.notEqual(UNIT_BLUEPRINTS[UnitType.Infantry].canTargetFlying, true);
  assert.equal(UNIT_BLUEPRINTS[UnitType.Archer].canTargetFlying, true);
});

// ── getFrontUnitInLane ──────────────────────────────────────────────────────────────────────

test('getFrontUnitInLane picks the leading unit per side and returns null for an empty lane', () => {
  const board = new Board();
  const bottomBack = unitAt(UnitType.Infantry, Side.Bottom, 3, 4);
  const bottomFront = unitAt(UnitType.Infantry, Side.Bottom, 3, 9);
  const topBack = unitAt(UnitType.Infantry, Side.Top, 3, 14);
  const topFront = unitAt(UnitType.Infantry, Side.Top, 3, 11);
  for (const u of [bottomBack, bottomFront, topBack, topFront]) board.addUnit(u);

  // Bottom advances toward row 17, so its front is the HIGHEST row it holds…
  assert.equal(board.getFrontUnitInLane(3, Side.Bottom), bottomFront);
  // …and Top advances toward row 0, so its front is the LOWEST.
  assert.equal(board.getFrontUnitInLane(3, Side.Top), topFront);
});

test('getFrontUnitInLane returns null when the lane holds nobody on that side (both directions)', () => {
  const board = new Board();
  // An empty column: both loops must run to completion and fall through to null.
  assert.equal(board.getFrontUnitInLane(7, Side.Bottom), null);
  assert.equal(board.getFrontUnitInLane(7, Side.Top), null);

  // A column that holds ONLY the other side: the loop visits occupied cells, matches nothing,
  // and still falls through — the arm that a `return unit` without the side check would break.
  board.addUnit(unitAt(UnitType.Infantry, Side.Top, 7, 12));
  assert.equal(board.getFrontUnitInLane(7, Side.Bottom), null);
  assert.notEqual(board.getFrontUnitInLane(7, Side.Top), null);

  board.addUnit(unitAt(UnitType.Infantry, Side.Bottom, 8, 5));
  assert.equal(board.getFrontUnitInLane(8, Side.Top), null);
  assert.notEqual(board.getFrontUnitInLane(8, Side.Bottom), null);
});

// ── getFriendlyUnitAhead (collision) ────────────────────────────────────────────────────────

test('getFriendlyUnitAhead returns null for an empty or single-occupant lane', () => {
  const board = new Board();
  const lone = unitAt(UnitType.Infantry, Side.Bottom, 2, 5);
  assert.equal(board.getFriendlyUnitAhead(lone), null, 'not even in the column list yet');
  board.addUnit(lone);
  assert.equal(board.getFriendlyUnitAhead(lone), null, 'a unit is never ahead of itself');
});

test('getFriendlyUnitAhead picks the NEAREST friend ahead, per direction of travel', () => {
  const board = new Board();
  const me = unitAt(UnitType.Infantry, Side.Bottom, 2, 5);
  const near = unitAt(UnitType.Infantry, Side.Bottom, 2, 7);
  const far = unitAt(UnitType.Infantry, Side.Bottom, 2, 12);
  const behind = unitAt(UnitType.Infantry, Side.Bottom, 2, 1);
  for (const u of [me, near, far, behind]) board.addUnit(u);
  assert.equal(board.getFriendlyUnitAhead(me), near, 'Bottom: ahead = larger y');

  const topMe = unitAt(UnitType.Infantry, Side.Top, 9, 12);
  const topNear = unitAt(UnitType.Infantry, Side.Top, 9, 10);
  const topFar = unitAt(UnitType.Infantry, Side.Top, 9, 3);
  const topBehind = unitAt(UnitType.Infantry, Side.Top, 9, 15);
  for (const u of [topMe, topNear, topFar, topBehind]) board.addUnit(u);
  assert.equal(board.getFriendlyUnitAhead(topMe), topNear, 'Top: ahead = smaller y');
});

test('getFriendlyUnitAhead skips a corpse ahead and finds the living friend behind it', () => {
  const board = new Board();
  const me = unitAt(UnitType.Infantry, Side.Bottom, 4, 5);
  const corpse = kill(unitAt(UnitType.Infantry, Side.Bottom, 4, 6));
  const alive = unitAt(UnitType.Infantry, Side.Bottom, 4, 8);
  for (const u of [me, corpse, alive]) board.addUnit(u);
  assert.equal(board.getFriendlyUnitAhead(me), alive, 'a body must not block the lane');
});

test('getFriendlyUnitAhead skips a unit that is Dead-stated but not yet at 0 HP', () => {
  // The two conditions are separate on purpose: a unit enters UnitState.Dead a few ticks before
  // it is removed, and during those ticks `isDead` can still be false.
  const board = new Board();
  const me = unitAt(UnitType.Infantry, Side.Bottom, 4, 5);
  const dying = unitAt(UnitType.Infantry, Side.Bottom, 4, 6);
  dying.state = UnitState.Dead;
  assert.equal(dying.isDead, false, 'test setup: still has HP');
  board.addUnit(me);
  board.addUnit(dying);
  assert.equal(board.getFriendlyUnitAhead(me), null);
});

test('getFriendlyUnitAhead ignores a flyer above a ground unit, and vice versa', () => {
  const board = new Board();
  const ground = unitAt(UnitType.Infantry, Side.Bottom, 6, 5);
  const flyer = unitAt(UnitType.Harpy, Side.Bottom, 6, 6);
  board.addUnit(ground);
  board.addUnit(flyer);
  assert.equal(board.getFriendlyUnitAhead(ground), null, 'ground units do not collide with flyers');

  // Symmetric: from the flyer's point of view the ground unit is behind AND on another plane.
  const flyerFront = unitAt(UnitType.Harpy, Side.Bottom, 6, 3);
  board.addUnit(flyerFront);
  assert.equal(board.getFriendlyUnitAhead(flyer), null, 'nothing flying is ahead of the flyer');

  // ...but two flyers DO collide with each other.
  const flyerAhead = unitAt(UnitType.Harpy, Side.Bottom, 6, 9);
  board.addUnit(flyerAhead);
  assert.equal(board.getFriendlyUnitAhead(flyer), flyerAhead);
});

test('getFriendlyUnitAhead ignores enemies entirely', () => {
  const board = new Board();
  const me = unitAt(UnitType.Infantry, Side.Bottom, 1, 5);
  const enemy = unitAt(UnitType.Infantry, Side.Top, 1, 7);
  board.addUnit(me);
  board.addUnit(enemy);
  assert.equal(board.getFriendlyUnitAhead(me), null);
});

// ── getEnemyUnitAhead (stop one cell short) ─────────────────────────────────────────────────

test('getEnemyUnitAhead returns null for an empty or single-occupant lane', () => {
  const board = new Board();
  const lone = unitAt(UnitType.Infantry, Side.Bottom, 2, 5);
  assert.equal(board.getEnemyUnitAhead(lone), null);
  board.addUnit(lone);
  assert.equal(board.getEnemyUnitAhead(lone), null);
});

test('getEnemyUnitAhead picks the nearest enemy ahead, per direction of travel', () => {
  const board = new Board();
  const me = unitAt(UnitType.Infantry, Side.Bottom, 3, 5);
  const near = unitAt(UnitType.Infantry, Side.Top, 3, 7);
  const far = unitAt(UnitType.Infantry, Side.Top, 3, 12);
  const behind = unitAt(UnitType.Infantry, Side.Top, 3, 2);
  for (const u of [me, near, far, behind]) board.addUnit(u);
  assert.equal(board.getEnemyUnitAhead(me), near);

  const topMe = unitAt(UnitType.Infantry, Side.Top, 10, 12);
  const topNear = unitAt(UnitType.Infantry, Side.Bottom, 10, 10);
  const topBehind = unitAt(UnitType.Infantry, Side.Bottom, 10, 15);
  for (const u of [topMe, topNear, topBehind]) board.addUnit(u);
  assert.equal(board.getEnemyUnitAhead(topMe), topNear);
});

test('getEnemyUnitAhead skips a dead enemy — a corpse must not stop an advance', () => {
  const board = new Board();
  const me = unitAt(UnitType.Infantry, Side.Bottom, 5, 5);
  const corpse = kill(unitAt(UnitType.Infantry, Side.Top, 5, 6));
  const alive = unitAt(UnitType.Infantry, Side.Top, 5, 9);
  for (const u of [me, corpse, alive]) board.addUnit(u);
  assert.equal(board.getEnemyUnitAhead(me), alive);

  // ...and the state-only marker case, same as the friendly scan.
  const board2 = new Board();
  const me2 = unitAt(UnitType.Infantry, Side.Bottom, 5, 5);
  const dying = unitAt(UnitType.Infantry, Side.Top, 5, 6);
  dying.state = UnitState.Dead;
  board2.addUnit(me2);
  board2.addUnit(dying);
  assert.equal(board2.getEnemyUnitAhead(me2), null);
});

test('a melee unit does not stop for a flyer it cannot hit, but an archer does', () => {
  // This mirrors CombatSystem.findTarget's flying filter. If the two disagree, an Infantry
  // stops one cell short of a Harpy, never engages it, and stands there for the rest of the
  // match while the harpy walks past its base.
  const board = new Board();
  const melee = unitAt(UnitType.Infantry, Side.Bottom, 8, 5);
  const harpy = unitAt(UnitType.Harpy, Side.Top, 8, 7);
  board.addUnit(melee);
  board.addUnit(harpy);
  assert.equal(board.getEnemyUnitAhead(melee), null, 'melee walks on past an untargetable flyer');

  const archer = unitAt(UnitType.Archer, Side.Bottom, 8, 4);
  board.addUnit(archer);
  assert.equal(board.getEnemyUnitAhead(archer), harpy, 'an archer CAN hit it, so it stops');

  // And a melee unit still stops for a ground enemy behind the flyer — the filter skips the
  // flyer, it does not abandon the scan.
  const ground = unitAt(UnitType.Infantry, Side.Top, 8, 9);
  board.addUnit(ground);
  assert.equal(board.getEnemyUnitAhead(melee), ground);
});

test('getEnemyUnitAhead ignores friends entirely', () => {
  const board = new Board();
  const me = unitAt(UnitType.Infantry, Side.Bottom, 11, 5);
  const friend = unitAt(UnitType.Infantry, Side.Bottom, 11, 7);
  board.addUnit(me);
  board.addUnit(friend);
  assert.equal(board.getEnemyUnitAhead(me), null);
});
