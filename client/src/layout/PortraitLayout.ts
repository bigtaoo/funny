import { BOARD_COLS, BOARD_ROWS, BASE_COLS } from '../game/config';
import { Side } from '../game';
import { ILayout, Orientation, Rect } from './ILayout';

// ── Design constants ──────────────────────────────────────────────────────────

const DESIGN_W   = 1080;
const DESIGN_H   = 1920;
const CELL       = 84;
const HUD_TOP_H  = 70;
const HUD_BOT_H  = 70;
const BOARD_X    = (DESIGN_W - BOARD_COLS * CELL) / 2;  // 36 — center the grid
const BOARD_Y    = HUD_TOP_H;                           // 70
const BOARD_W    = BOARD_COLS * CELL;                   // 1008
const BOARD_H    = BOARD_ROWS * CELL;                   // 1512
const HUD_BOT_Y  = BOARD_Y + BOARD_H;                  // 1582
const HAND_Y     = HUD_BOT_Y + HUD_BOT_H;              // 1652
const HAND_H     = DESIGN_H - HAND_Y;                  // 268

/**
 * Portrait layout — design resolution 1080 × 1920.
 *
 * Grid orientation:
 *   col increases left → right
 *   row 0 (player base) appears at the BOTTOM of the board for localSide=Bottom
 */
export class PortraitLayout implements ILayout {
  readonly orientation:  Orientation = 'portrait';
  readonly localSide:    Side;
  readonly cellSize    = CELL;
  readonly designWidth  = DESIGN_W;
  readonly designHeight = DESIGN_H;

  readonly boardRect:          Rect = { x: BOARD_X, y: BOARD_Y, w: BOARD_W, h: BOARD_H };
  readonly hudTopRect:         Rect = { x: 0, y: 0, w: DESIGN_W, h: HUD_TOP_H };
  readonly hudBottomLeftRect:  Rect = { x: 0,               y: HUD_BOT_Y, w: 360,        h: HUD_BOT_H };
  readonly hudBottomRightRect: Rect = { x: DESIGN_W - 360,  y: HUD_BOT_Y, w: 360,        h: HUD_BOT_H };
  readonly handRect:           Rect = { x: 0, y: HAND_Y,    w: DESIGN_W,  h: HAND_H };

  readonly cardWidth  = 155;
  readonly cardHeight = 190;
  readonly cardMargin = 8;

  constructor(localSide: Side = Side.Bottom) {
    this.localSide = localSide;
  }

  // ── Coordinate transforms ──────────────────────────────────────────────────

  gridToScreen(col: number, row: number): { x: number; y: number } {
    if (this.localSide === Side.Bottom) {
      return {
        x: BOARD_X + col * CELL + CELL / 2,
        y: BOARD_Y + (BOARD_ROWS - 1 - row) * CELL + CELL / 2,
      };
    }
    // Player 1: 180° rotation (mirror both axes)
    return {
      x: BOARD_X + (BOARD_COLS - 1 - col) * CELL + CELL / 2,
      y: BOARD_Y + row * CELL + CELL / 2,
    };
  }

  screenToCol(sx: number, _sy: number): number {
    const raw = Math.floor((sx - BOARD_X) / CELL);
    return this.localSide === Side.Bottom ? raw : BOARD_COLS - 1 - raw;
  }

  screenToRow(_sx: number, sy: number): number {
    const raw = Math.floor((sy - BOARD_Y) / CELL);
    return this.localSide === Side.Bottom
      ? BOARD_ROWS - 1 - raw
      : raw;
  }

  isOutsideBoard(sx: number, sy: number): boolean {
    return sx < BOARD_X || sx > BOARD_X + BOARD_W
        || sy < BOARD_Y || sy > BOARD_Y + BOARD_H;
  }

  playerBaseRect(): Rect {
    if (this.localSide === Side.Bottom) {
      // Rows 0-1 appear at the bottom of the board
      return {
        x: BOARD_X + BASE_COLS[0] * CELL,
        y: BOARD_Y + (BOARD_ROWS - 2) * CELL,
        w: 2 * CELL,
        h: 2 * CELL,
      };
    }
    // Player 1: rows 16-17 appear at the top
    return {
      x: BOARD_X + (BOARD_COLS - 1 - BASE_COLS[1]) * CELL,
      y: BOARD_Y,
      w: 2 * CELL,
      h: 2 * CELL,
    };
  }

  enemyBaseRect(): Rect {
    if (this.localSide === Side.Bottom) {
      // Enemy rows 16-17 appear at the top of the board
      return {
        x: BOARD_X + BASE_COLS[0] * CELL,
        y: BOARD_Y,
        w: 2 * CELL,
        h: 2 * CELL,
      };
    }
    // Player 1: enemy rows 0-1 appear at the bottom
    return {
      x: BOARD_X + (BOARD_COLS - 1 - BASE_COLS[1]) * CELL,
      y: BOARD_Y + (BOARD_ROWS - 2) * CELL,
      w: 2 * CELL,
      h: 2 * CELL,
    };
  }
}
