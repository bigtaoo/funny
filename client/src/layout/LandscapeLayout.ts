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

const DESIGN_H  = 1080;
const CELL      = 70;

const HUD_TOP_H = 60;
const BOT_H     = 180;

// Board occupies: 18 columns (game rows) × 12 rows (game cols)
const BOARD_W   = BOARD_ROWS * CELL;  // 18 × 70 = 1260
const BOARD_H   = BOARD_COLS * CELL;  // 12 × 70 = 840
const BOARD_Y   = HUD_TOP_H;          // 60 — vertical origin is fixed (height never grows)

// Bottom strip y start
const BOT_Y     = BOARD_Y + BOARD_H;  // 60 + 840 = 900

// Bottom strip column widths (spec: ~300 / flexible middle / ~200)
const BOT_LEFT_W  = 300;
const BOT_RIGHT_W = 200;

// Card dimensions in landscape (ui-design.md §5.2: ~200×160px)
const CARD_W   = 200;
const CARD_H   = 160;
const CARD_MAR = 8;

/**
 * Classic 16:9 design width. On screens with exactly this aspect the layout is
 * identical to the historical fixed 1920×1080 board. Wider screens (tall phones
 * held sideways = ~19.5:9, etc.) get a proportionally wider design space so the
 * game fills the full width instead of being letterboxed with dead bands left
 * and right.
 */
const REFERENCE_W = 1920;

/**
 * Landscape layout — design height fixed at 1080; design width follows the aspect
 * of the *safe drawable area* (never narrower than 1920) so `ScalingManager`'s
 * fit-to-height scaling leaves no side letterbox. Safe-area insets are handled
 * once, by ScalingManager offsetting the whole game layer inside the safe region
 * — so this layout simply anchors to its own 0…designWidth edges and every scene
 * (battle and menu) is protected uniformly.
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
  readonly designWidth:  number;
  readonly designHeight = DESIGN_H;

  readonly boardRect:          Rect;
  readonly hudTopRect:         Rect;
  readonly hudBottomLeftRect:  Rect;
  readonly hudBottomRightRect: Rect;
  /** The center section of the bottom strip — where 6 hand cards are rendered. */
  readonly handRect:           Rect;

  readonly cardWidth  = CARD_W;
  readonly cardHeight = CARD_H;
  readonly cardMargin = CARD_MAR;

  // Board X origin in design space (instance-level — depends on the dynamic width).
  private readonly boardX: number;

  /**
   * @param availW  Safe drawable area width  (CSS px) — viewport minus L/R insets.
   * @param availH  Safe drawable area height (CSS px) — viewport minus T/B insets.
   * @param localSide Which side is "mine" (bottom for SP/host, top for netplay joiner).
   */
  constructor(
    availW: number,
    availH: number,
    localSide: Side = Side.Bottom,
  ) {
    this.localSide = localSide;

    // Design width matches the safe-area aspect (fit-to-height leaves no letterbox),
    // clamped so a squat/near-4:3 landscape still gets the classic 1920 width.
    const aspectW = Math.round(DESIGN_H * (availW / Math.max(1, availH)));
    this.designWidth = Math.max(REFERENCE_W, aspectW);

    // Center the board horizontally in the (possibly widened) design space. The
    // vertical layout is unchanged — height is fixed, only width is reclaimed.
    this.boardX = Math.round((this.designWidth - BOARD_W) / 2);

    this.boardRect          = { x: this.boardX, y: BOARD_Y, w: BOARD_W, h: BOARD_H };
    this.hudTopRect         = { x: 0, y: 0, w: this.designWidth, h: HUD_TOP_H };
    this.hudBottomLeftRect  = { x: 0, y: BOT_Y, w: BOT_LEFT_W, h: BOT_H };
    this.hudBottomRightRect = { x: this.designWidth - BOT_RIGHT_W, y: BOT_Y, w: BOT_RIGHT_W, h: BOT_H };
    this.handRect           = { x: BOT_LEFT_W, y: BOT_Y, w: this.designWidth - BOT_LEFT_W - BOT_RIGHT_W, h: BOT_H };
  }

  // ── Coordinate transforms ──────────────────────────────────────────────────

  gridToScreen(col: number, row: number): { x: number; y: number } {
    if (this.localSide === Side.Bottom) {
      return {
        x: this.boardX + row * CELL + CELL / 2,     // game row → screen X
        y: BOARD_Y + col * CELL + CELL / 2,          // game col → screen Y
      };
    }
    // Player 1: mirror both axes
    return {
      x: this.boardX + (BOARD_ROWS - 1 - row) * CELL + CELL / 2,
      y: BOARD_Y + (BOARD_COLS - 1 - col) * CELL + CELL / 2,
    };
  }

  screenToCol(_sx: number, sy: number): number {
    const raw = Math.floor((sy - BOARD_Y) / CELL);
    return this.localSide === Side.Bottom ? raw : BOARD_COLS - 1 - raw;
  }

  screenToRow(sx: number, _sy: number): number {
    const raw = Math.floor((sx - this.boardX) / CELL);
    return this.localSide === Side.Bottom ? raw : BOARD_ROWS - 1 - raw;
  }

  isOutsideBoard(sx: number, sy: number): boolean {
    return sx < this.boardX || sx > this.boardX + BOARD_W
        || sy < BOARD_Y || sy > BOARD_Y + BOARD_H;
  }

  playerBaseRect(): Rect {
    if (this.localSide === Side.Bottom) {
      // game rows 0-1 → leftmost X; game cols 5-6 → middle Y
      return {
        x: this.boardX + 0 * CELL,
        y: BOARD_Y + BASE_COLS[0] * CELL,
        w: 2 * CELL,
        h: 2 * CELL,
      };
    }
    // Player 1: game rows 16-17 → rightmost X; game cols 5-6 → middle Y (mirrored)
    return {
      x: this.boardX + (BOARD_ROWS - 2) * CELL,
      y: BOARD_Y + (BOARD_COLS - 1 - BASE_COLS[1]) * CELL,
      w: 2 * CELL,
      h: 2 * CELL,
    };
  }

  enemyBaseRect(): Rect {
    if (this.localSide === Side.Bottom) {
      // Enemy rows 16-17 → rightmost X
      return {
        x: this.boardX + (BOARD_ROWS - 2) * CELL,
        y: BOARD_Y + BASE_COLS[0] * CELL,
        w: 2 * CELL,
        h: 2 * CELL,
      };
    }
    // Player 1: enemy rows 0-1 → leftmost X
    return {
      x: this.boardX,
      y: BOARD_Y + (BOARD_COLS - 1 - BASE_COLS[1]) * CELL,
      w: 2 * CELL,
      h: 2 * CELL,
    };
  }
}
