import { describe, it, expect } from 'vitest';
import { Board } from '../src/game/Board';
import { Unit } from '../src/game/Unit';
import { GameState } from '../src/game/GameState';
import { toFp } from '../src/game/math/fixed';
import { Side, UnitType } from '../src/game/types';

// Regression coverage for the columnUnits bookkeeping fix: when a unit changes
// column (e.g. a leader entering Crossing and moving sideways), it must be moved
// out of its old column's collision list — otherwise trailing units keep treating
// it as the "unit ahead" forever and stay stuck Waiting behind a phantom.
describe('Board — column list migration on cross-column move', () => {
  it('a unit that changes column is removed from its old column collision list', () => {
    new GameState(1); // reset id counters
    const board = new Board();
    // Two Bottom units in col 0; `ahead` is closer to the enemy (higher row).
    const behind = new Unit(UnitType.Infantry, Side.Bottom, 0, 5);
    const ahead = new Unit(UnitType.Infantry, Side.Bottom, 0, 8);
    board.addUnit(behind);
    board.addUnit(ahead);

    // While both share col 0, `ahead` blocks `behind`.
    expect(board.getFriendlyUnitAhead(behind)).toBe(ahead);

    // `ahead` crosses into col 1 (row unchanged) — exactly what a Crossing unit does.
    ahead.col = 1;
    ahead.x_fp = toFp(1);
    board.updateUnitCell(ahead, ahead.row, 0); // oldRow = current row, oldCol = 0

    // It must no longer be "ahead" in col 0; otherwise the trailing unit waits
    // forever behind a phantom leader (the stale-columnUnits regression).
    expect(board.getFriendlyUnitAhead(behind)).toBeNull();
  });
});

describe('Board — isCellOccupiedByUnit', () => {
  it('reports occupancy and clears once the unit moves off the cell', () => {
    new GameState(1);
    const board = new Board();
    const u = new Unit(UnitType.Infantry, Side.Bottom, 3, 1);
    board.addUnit(u);

    expect(board.isCellOccupiedByUnit(3, 1)).toBe(true);
    expect(board.isCellOccupiedByUnit(3, 2)).toBe(false);

    // Unit advances to row 2.
    u.y_fp = toFp(2);
    board.updateUnitCell(u, 1, 3); // oldRow = 1, oldCol = 3

    expect(board.isCellOccupiedByUnit(3, 1)).toBe(false);
    expect(board.isCellOccupiedByUnit(3, 2)).toBe(true);
  });
});
