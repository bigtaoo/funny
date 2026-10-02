import { BOARD_COLS, BOARD_ROWS, BASE_COLS } from '@nw/engine/config';
import { Side } from '../game';
import { ILayout, Orientation, Rect } from './ILayout';
import {
  REFERENCE_SHORT, landscapeDesignHeight, landscapeDesignWidth,
} from './designSize';

// ── Design constants ──────────────────────────────────────────────────────────
//
//  In landscape the game logic axes are transposed onto the screen:
//    game col (0–11)  → screen Y   (12 vertical bands)
//    game row (0–17)  → screen X   (18 horizontal bands)
//
//  Player 0 (Side.Bottom) base is at game rows 0-1, so it appears on the
//  LEFT side of the landscape screen.
//
//  All of these are at the classic 1080-tall reference. The design height now follows the screen
//  (layout/designSize.ts — 720–860 on phones held sideways), and the battle geometry is scaled by
//  `designHeight / 1080`, so the board and HUD strips cover the same share of the screen as before.

const CELL      = 70;
const HUD_TOP_H = 60;

// Bottom strip column widths (spec: ~300 / flexible middle / ~200)
const BOT_LEFT_W  = 300;
const BOT_RIGHT_W = 200;

// Card dimensions in landscape (ui-design.md §5.2: ~200×160px)
const CARD_W   = 200;
const CARD_H   = 160;
const CARD_MAR = 8;

/**
 * Landscape layout — design height from {@link landscapeDesignHeight} (1080 on tablets/desktop,
 * 720–860 on phones held sideways); design width follows the aspect
 * of the *safe drawable area* (never narrower than the scaled 1920, never wider
 * than the scaled 2592) so `ScalingManager`'s fit-to-height scaling leaves no side
 * letterbox on any real phone. Safe-area insets are handled
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
  readonly cellSize:     number;
  readonly designWidth:  number;
  readonly designHeight: number;

  readonly boardRect:          Rect;
  readonly hudTopRect:         Rect;
  readonly hudBottomLeftRect:  Rect;
  readonly hudBottomRightRect: Rect;
  /** The center section of the bottom strip — where 6 hand cards are rendered. */
  readonly handRect:           Rect;

  readonly cardWidth:  number;
  readonly cardHeight: number;
  readonly cardMargin: number;

  // Board origin and size in design space (instance-level — depend on the dynamic width/height).
  private readonly boardX: number;
  private readonly boardY: number;
  private readonly boardW: number;
  private readonly boardH: number;

  // Safe drawable area (CSS px) the layout was built for — retained so `mirrored()`
  // can rebuild an identical layout for the opposite side.
  private readonly availW: number;
  private readonly availH: number;

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
    this.availW = availW;
    this.availH = availH;

    this.designHeight = landscapeDesignHeight(availH);
    // Design width matches the safe-area aspect (fit-to-height leaves no letterbox), clamped at both
    // ends: a squat/near-4:3 landscape still gets the scaled classic 1920 width, and a viewport wider
    // than any real phone stops widening and letterboxes onto the desk surround instead.
    this.designWidth = landscapeDesignWidth(availW, availH);
    const k = this.designHeight / REFERENCE_SHORT;
    // Whole design px per cell, so grid lines and hit-testing stay on integer boundaries.
    const cell = Math.floor(CELL * k);
    this.cellSize   = cell;
    this.cardWidth  = Math.round(CARD_W * k);
    this.cardHeight = Math.round(CARD_H * k);
    this.cardMargin = Math.max(4, Math.round(CARD_MAR * k));
    this.boardW = BOARD_ROWS * cell;
    this.boardH = BOARD_COLS * cell;
    this.boardY = Math.round(HUD_TOP_H * k);
    // The bottom strip absorbs per-term rounding so the three bands stack to exactly designHeight.
    const botY = this.boardY + this.boardH;
    const botH = this.designHeight - botY;
    const botLeftW  = Math.round(BOT_LEFT_W * k);
    const botRightW = Math.round(BOT_RIGHT_W * k);

    // Center the board horizontally in the (possibly widened) design space.
    this.boardX = Math.round((this.designWidth - this.boardW) / 2);

    // Anchor every HUD element to the board's own horizontal extent rather than
    // the (possibly much wider) design-space edges: the hand fills the board
    // width exactly, the ink/HP column sits in the left paper margin hugging the
    // board's left edge, and the refresh/upgrade column sits in the right margin
    // hugging the board's right edge. Each side margin is `boardX` wide, and
    // boardX ≥ (1920−1260)/2 = 330 (scaled by k) for every allowed design width — always enough
    // for the 300px left column and the 200px right column (same k).
    const boardRight = this.boardX + this.boardW;

    this.boardRect          = { x: this.boardX, y: this.boardY, w: this.boardW, h: this.boardH };
    this.hudTopRect         = { x: 0, y: 0, w: this.designWidth, h: this.boardY };
    this.hudBottomLeftRect  = { x: this.boardX - botLeftW, y: botY, w: botLeftW, h: botH };
    this.hudBottomRightRect = { x: boardRight,             y: botY, w: botRightW, h: botH };
    this.handRect           = { x: this.boardX, y: botY, w: this.boardW, h: botH };
  }

  // ── Coordinate transforms ──────────────────────────────────────────────────

  gridToScreen(col: number, row: number): { x: number; y: number } {
    if (this.localSide === Side.Bottom) {
      return {
        x: this.boardX + row * this.cellSize + this.cellSize / 2,  // game row → screen X
        y: this.boardY + col * this.cellSize + this.cellSize / 2,  // game col → screen Y
      };
    }
    // Player 1: mirror both axes
    return {
      x: this.boardX + (BOARD_ROWS - 1 - row) * this.cellSize + this.cellSize / 2,
      y: this.boardY + (BOARD_COLS - 1 - col) * this.cellSize + this.cellSize / 2,
    };
  }

  screenToCol(_sx: number, sy: number): number {
    const raw = Math.floor((sy - this.boardY) / this.cellSize);
    return this.localSide === Side.Bottom ? raw : BOARD_COLS - 1 - raw;
  }

  screenToRow(sx: number, _sy: number): number {
    const raw = Math.floor((sx - this.boardX) / this.cellSize);
    return this.localSide === Side.Bottom ? raw : BOARD_ROWS - 1 - raw;
  }

  isOutsideBoard(sx: number, sy: number): boolean {
    return sx < this.boardX || sx > this.boardX + this.boardW
        || sy < this.boardY || sy > this.boardY + this.boardH;
  }

  playerBaseRect(): Rect {
    if (this.localSide === Side.Bottom) {
      // game rows 0-1 → leftmost X; game cols 5-6 → middle Y
      return {
        x: this.boardX + 0 * this.cellSize,
        y: this.boardY + BASE_COLS[0] * this.cellSize,
        w: 2 * this.cellSize,
        h: 2 * this.cellSize,
      };
    }
    // Player 1 (joiner): gridToScreen mirrors the row axis, so the local player's
    // own base (game rows 16-17) renders at the LEFT — same near-side as the host
    // sees theirs. Must match gridToScreen, or the base sprite / crack / hit
    // outline lands on the wrong castle.
    return {
      x: this.boardX,
      y: this.boardY + (BOARD_COLS - 1 - BASE_COLS[1]) * this.cellSize,
      w: 2 * this.cellSize,
      h: 2 * this.cellSize,
    };
  }

  enemyBaseRect(): Rect {
    if (this.localSide === Side.Bottom) {
      // Enemy rows 16-17 → rightmost X
      return {
        x: this.boardX + (BOARD_ROWS - 2) * this.cellSize,
        y: this.boardY + BASE_COLS[0] * this.cellSize,
        w: 2 * this.cellSize,
        h: 2 * this.cellSize,
      };
    }
    // Player 1 (joiner): mirrored, so the enemy base (game rows 0-1) renders at
    // the RIGHT (far side). Mirror image of the player rect above.
    return {
      x: this.boardX + (BOARD_ROWS - 2) * this.cellSize,
      y: this.boardY + (BOARD_COLS - 1 - BASE_COLS[1]) * this.cellSize,
      w: 2 * this.cellSize,
      h: 2 * this.cellSize,
    };
  }

  mirrored(): ILayout {
    const other = this.localSide === Side.Bottom ? Side.Top : Side.Bottom;
    return new LandscapeLayout(this.availW, this.availH, other);
  }
}
