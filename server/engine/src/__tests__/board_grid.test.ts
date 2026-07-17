/**
 * Board spatial-grid invariants — the multi-occupant unitGrid must never drop a live
 * unit, the defect behind the "ghost" bug (see ghost_untargetable.test.ts).
 *
 * A cell can legitimately hold >1 unit (continuous fp positions snapped to an integer
 * cell; collision only guarantees a surface gap). The grid stores every occupant and
 * mutates by id, so co-located units never evict one another.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Board } from '../Board';
import { Unit } from '../Unit';
import { fp } from '../math/fixed';
import { Side, UnitType } from '../types';

/** A Runner pinned to an exact fp row (row = round(y_fp)). */
function runnerAt(side: Side, col: number, y_fp: number): Unit {
  const u = new Unit(UnitType.Runner, side, col, Math.round(y_fp / 1000));
  u.y_fp = fp(y_fp);
  return u;
}

test('adding a second unit to an occupied cell keeps BOTH findable', () => {
  const board = new Board();
  const a = runnerAt(Side.Top, 5, 5000);
  const b = runnerAt(Side.Top, 5, 5000); // exact same cell
  board.addUnit(a);
  board.addUnit(b);

  const here = board.getUnitsAt(5, 5);
  assert.equal(here.length, 2, 'both units must be indexed at the shared cell');
  assert.ok(here.includes(a) && here.includes(b));
  assert.ok(board.isCellOccupiedByUnit(5, 5));
});

test('getUnitsAt is ordered by id regardless of insertion order (deterministic / replay-safe)', () => {
  const board = new Board();
  // Ids come from an ascending counter, so `lo` (built first) has the lower id.
  // Insert them in the OPPOSITE order so insertion order != id order — the result
  // must still be id-sorted, or two engines that inserted in different orders would
  // pick different targets and diverge.
  const lo = runnerAt(Side.Top, 5, 5000);
  const hi = runnerAt(Side.Top, 5, 5000);
  assert.ok(lo.id < hi.id, 'test setup: lo must have the lower id');
  board.addUnit(hi);
  board.addUnit(lo);
  assert.deepEqual(board.getUnitsAt(5, 5).map(u => u.id), [lo.id, hi.id]);
});

test('a unit moving off a shared cell does NOT evict the cell-mate (stale-clear guard)', () => {
  const board = new Board();
  const stay = runnerAt(Side.Top, 5, 5000); // stays on (5,5)
  const move = runnerAt(Side.Top, 5, 5000); // will move to (5,6)
  board.addUnit(stay);
  board.addUnit(move);
  assert.equal(board.getUnitsAt(5, 5).length, 2);

  // `move` advances one row; row is a getter off y_fp, col is unchanged.
  move.y_fp = fp(6000);
  board.updateUnitCell(move, /* oldRow */ 5, /* oldCol */ 5);

  const at5 = board.getUnitsAt(5, 5);
  assert.deepEqual(at5.map(u => u.id), [stay.id], 'cell-mate wrongly evicted by the mover');
  assert.ok(board.getUnitsAt(5, 6).includes(move), 'mover not re-indexed at its new cell');
});

test('removeUnit clears only that id, leaving a co-located unit indexed', () => {
  const board = new Board();
  const keep = runnerAt(Side.Top, 5, 5000);
  const drop = runnerAt(Side.Top, 5, 5000);
  board.addUnit(keep);
  board.addUnit(drop);

  board.removeUnit(drop);

  assert.deepEqual(board.getUnitsAt(5, 5).map(u => u.id), [keep.id]);
  assert.ok(board.isCellOccupiedByUnit(5, 5));

  board.removeUnit(keep);
  assert.equal(board.getUnitsAt(5, 5).length, 0);
  assert.ok(!board.isCellOccupiedByUnit(5, 5), 'emptied cell must report unoccupied');
});

test('getFrontUnitInLane finds the friendly even when an enemy shares its cell', () => {
  const board = new Board();
  // Enemy (Top) added first → lower id; a naive lowest-id lookup would return it and
  // hide the friendly Bottom unit sharing the cell.
  const enemy    = runnerAt(Side.Top, 5, 5000);
  const friendly = runnerAt(Side.Bottom, 5, 5000);
  board.addUnit(enemy);
  board.addUnit(friendly);

  assert.equal(board.getFrontUnitInLane(5, Side.Bottom), friendly);
  assert.equal(board.getFrontUnitInLane(5, Side.Top), enemy);
});
