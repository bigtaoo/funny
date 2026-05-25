import {
  BASE_COLS,
  BOTTOM_TRANSIT_ROW,
  TOP_TRANSIT_ROW,
} from '../config';
import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { Side, UnitState } from '../types';

export class MovementSystem {
  tick(state: GameState, dt: number): void {
    const board = state.board;
    const units = Array.from(board.units.values());

    for (const unit of units) {
      if (unit.isDead || unit.state === UnitState.Attacking) continue;

      const oldRow = Math.round(unit.row);

      if (unit.state === UnitState.Crossing) {
        this.moveCrossing(unit, dt, state);
      } else {
        this.moveForward(unit, dt, state, oldRow);
      }
    }

    // Remove dead units
    for (const unit of units) {
      if (unit.isDead) {
        board.removeUnit(unit);
      }
    }
  }

  private moveForward(unit: Unit, dt: number, state: GameState, oldRow: number): void {
    const board = state.board;
    const transitRow = unit.side === Side.Bottom ? TOP_TRANSIT_ROW : BOTTOM_TRANSIT_ROW;
    const direction = unit.side === Side.Bottom ? -1 : 1; // Bottom moves up (row-), Top moves down (row+)

    const targetRow = Math.round(unit.row) + direction;

    // Check if transit row reached
    if (targetRow === transitRow || (direction === -1 && Math.round(unit.row) <= TOP_TRANSIT_ROW + 1)
                                 || (direction === 1 && Math.round(unit.row) >= BOTTOM_TRANSIT_ROW - 1)) {
      // Snap to transit row and switch to crossing mode
      unit.row = transitRow;
      unit.rowExact = transitRow;
      unit.state = UnitState.Crossing;
      board.updateUnitCell(unit, oldRow);
      return;
    }

    // Check if next cell is blocked by friendly unit
    if (board.isCellOccupiedByUnit(unit.col, targetRow)) {
      const blocker = board.getUnitAt(unit.col, targetRow);
      if (blocker && blocker.side === unit.side) {
        unit.state = UnitState.Waiting;
        return;
      }
    }

    // Move
    unit.row += direction * unit.speed * dt;
    unit.rowExact = unit.row;
    board.updateUnitCell(unit, oldRow);
    unit.state = UnitState.Moving;
  }

  private moveCrossing(unit: Unit, dt: number, state: GameState): void {
    // Move horizontally toward base cols
    const targetCol = BASE_COLS[0]; // move toward col 3 (leftmost base col)
    const direction = unit.col < targetCol ? 1 : unit.col > BASE_COLS[1] ? -1 : 0;

    if (direction === 0) {
      // Reached base column — deal damage
      const opponent = state.getOpponent(unit.side);
      const damage = unit.attack;
      opponent.takeDamage(damage);
      state.pushEvent({ type: 'base_damaged', side: opponent.side, damage });
      unit.hp = 0; // unit is consumed on base hit
      unit.state = UnitState.Dead;
      state.board.removeUnit(unit);

      if (opponent.isDead) {
        state.pushEvent({ type: 'game_over', winner: unit.side });
      }
    } else {
      unit.col += direction; // snap movement (one cell per tick is fine for transit)
    }
  }
}
