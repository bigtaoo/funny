import { BOARD_COLS, BOARD_ROWS, BASE_COLS } from '../game/config';
import { Side } from '../game';
import { ILayout, Orientation, Rect } from './ILayout';

// ── Design constants ──────────────────────────────────────────────────────────
//
//  In landscape the game logic axes are transposed onto the screen:
//    game col (0–11)  → screen Y   (12 vertical bands)
//    game row (0–17)  → screen X   (18 horizontal bands)
//
//  Player 0 (Side.Bottom) base is at game rows 0-1, so it appears on the
//  LEFT side of the landscape screen.

const DESIGN_W  = 1920;
const DESIGN_H  = 1080;
const CELL      = 70;

const HUD_TOP_H = 60;
const BOT_H     = 180;

// Board occupies: 18 columns (game rows) × 12 rows (game cols)
const BOARD_W   = BOARD_ROWS * CELL;  // 18 × 70 = 1260
const BOARD_H   = BOARD_COLS * CELL;  // 12 × 70 = 840
const BOARD_X   = (DESIGN_W - BOARD_W) / 2;  // (1920 - 1260) / 2 = 330
const BOARD_Y   = HUD_TOP_H;                  // 60

// Bottom strip y start
const BOT_Y     = BOARD_Y + BOARD_H;  // 60 + 840 = 900

// Bottom strip column widths (spec: ~300 / ~1420 / ~200)
const BOT_LEFT_W  = 300;
const BOT_RIGHT_W = 200;
const BOT_MID_W   = DESIGN_W - BOT_LEFT_W - BOT_RIGHT_W; // 1420

// Card dimensions in landscape (ui-design.md §5.2: ~200×160px)
const CARD_W   = 200;
const CARD_H   = 160;
const CARD_MAR = 8;

/**
 * Landscape layout — design resolution 1920 × 1080.
 *
 * Grid orientation:
 *   game col (0–11) → screen Y (top to bottom)
 *   game row (0–17) → screen X (left to right for Side.Bottom)
 *
 * Player 0 base (game rows 0-1, cols 5-6) sits at the LEFT of the board.
 * Enemy base (game rows 16-17, cols 5-6) sits at the RIGHT.
 */
export class LandscapeLayout implements ILayout {
  readonly orientation:  Orientation = 'landscape';
  readonly localSide:    Side;
  readonly cellSize    = CELL;
  readonly designWidth  = DESIGN_W;
  readonly designHeight = DESIGN_H;

  readonly boardRect:          Rect = { x: BOARD_X, y: BOARD_Y, w: BOARD_W,       h: BOARD_H };
  readonly hudTopRect:         Rect = { x: 0,               y: 0,     w: DESIGN_W,    h: HUD_TOP_H };
  readonly hudBottomLeftRect:  Rect = { x: 0,               y: BOT_Y, w: BOT_LEFT_W,  h: BOT_H };
  readonly hudBottomRightRect: Rect = { x: DESIGN_W - BOT_RIGHT_W, y: BOT_Y, w: BOT_RIGHT_W, h: BOT_H };
  /** The center section of the bottom strip — where 6 hand cards are rendered. */
  readonly handRect:           Rect = { x: BOT_LEFT_W,      y: BOT_Y, w: BOT_MID_W,   h: BOT_H };

  readonly cardWidth  = CARD_W;
  readonly cardHeight = CARD_H;
  readonly cardMargin = CARD_MAR;

  constructor(localSide: Side = Side.Bottom) {
    this.localSide = localSide;
  }

  // ── Coordinate transforms ──────────────────────────────────────────────────

  gridToScreen(col: number, row: number): { x: number; y: number } {
    if (this.localSide === Side.Bottom) {
      return {
        x: BOARD_X + row * CELL + CELL / 2,        // game row → screen X
        y: BOARD_Y + col * CELL + CELL / 2,         // game col → screen Y
      };
    }
    // Player 1: mirror both axes
    return {
      x: BOARD_X + (BOARD_ROWS - 1 - row) * CELL + CELL / 2,
      y: BOARD_Y + (BOARD_COLS - 1 - col) * CELL + CELL / 2,
    };
  }

  screenToCol(_sx: number, sy: number): number {
    const raw = Math.floor((sy - BOARD_Y) / CELL);
    return this.localSide === Side.Bottom ? raw : BOARD_COLS - 1 - raw;
  }

  screenToRow(sx: number, _sy: number): number {
    const raw = Math.floor((sx - BOARD_X) / CELL);
    return this.localSide === Side.Bottom ? raw : BOARD_ROWS - 1 - raw;
  }

  isOutsideBoard(sx: number, sy: number): boolean {
    return sx < BOARD_X || sx > BOARD_X + BOARD_W
        || sy < BOARD_Y || sy > BOARD_Y + BOARD_H;
  }

  playerBaseRect(): Rect {
    if (this.localSide === Side.Bottom) {
      // game rows 0-1 → leftmost X; game cols 5-6 → middle Y
      return {
        x: BOARD_X + 0 * CELL,
        y: BOARD_Y + BASE_COLS[0] * CELL,
        w: 2 * CELL,
        h: 2 * CELL,
      };
    }
    // Player 1: game rows 16-17 → rightmost X; game cols 5-6 → middle Y (mirrored)
    return {
      x: BOARD_X + (BOARD_ROWS - 2) * CELL,
      y: BOARD_Y + (BOARD_COLS - 1 - BASE_COLS[1]) * CELL,
      w: 2 * CELL,
      h: 2 * CELL,
    };
  }
}
