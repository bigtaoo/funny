import { BOARD_COLS, BOARD_ROWS, BASE_COLS } from '@nw/engine/config';
import { Side } from '../game';
import { ILayout, Orientation, Rect } from './ILayout';

import { REFERENCE_SHORT, portraitDesignWidth } from './designSize';

// ── Design constants ──────────────────────────────────────────────────────────
//
// All of these are at the classic 1080-wide reference. The design width now follows the screen
// (layout/designSize.ts — 720–860 on phones), and the battle geometry is scaled by
// `designWidth / 1080` so the board, HUD strips and hand cover the same share of the screen as
// before: on a phone the board still spans the width edge to edge, it is just counted in fewer
// design px.

const CELL       = 84;
const HUD_TOP_H  = 70;
const HUD_BOT_H  = 70;
const HAND_H     = 268;
const HUD_BOT_W  = 360;

/**
 * Classic 9:16 design height. On screens with exactly this aspect the layout is
 * identical to the historical fixed 1080×1920 board. Taller screens (iPhone 13 =
 * ~9:19.5, etc.) get a proportionally taller design space so the game fills the
 * full height instead of being letterboxed with dead bands top and bottom.
 */
const REFERENCE_H = 1920;

/**
 * Portrait layout — design width from {@link portraitDesignWidth} (1080 on tablets, 720–860 on
 * phones); design height follows the aspect
 * of the *safe drawable area* (never shorter than 1920) so `ScalingManager`'s
 * fit-to-width scaling leaves no letterbox. Safe-area insets are handled once, by
 * ScalingManager offsetting the whole game layer inside the safe region — so this
 * layout simply anchors to its own 0…designHeight edges and every scene (battle
 * and menu) is protected uniformly.
 *
 * Vertical anchoring on the reclaimed space:
 *   · top HUD           → anchored to the top edge
 *   · hand + bottom HUD → anchored to the bottom edge
 *   · board             → centered in the space between the two HUD strips
 *
 * Grid orientation:
 *   col increases left → right
 *   row 0 (player base) appears at the BOTTOM of the board for localSide=Bottom
 */
export class PortraitLayout implements ILayout {
  readonly orientation:  Orientation = 'portrait';
  readonly localSide:    Side;
  readonly cellSize:     number;
  readonly designWidth:  number;
  readonly designHeight: number;

  readonly boardRect:          Rect;
  readonly hudTopRect:         Rect;
  readonly hudBottomLeftRect:  Rect;
  readonly hudBottomRightRect: Rect;
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

    this.designWidth = portraitDesignWidth(availW);
    const k = this.designWidth / REFERENCE_SHORT;
    // Whole design px per cell, so grid lines and hit-testing stay on integer boundaries.
    const cell = Math.floor(CELL * k);
    this.cellSize   = cell;
    this.cardWidth  = Math.round(155 * k);
    this.cardHeight = Math.round(190 * k);
    this.cardMargin = Math.max(4, Math.round(8 * k));
    const hudTopH = Math.round(HUD_TOP_H * k);
    const hudBotH = Math.round(HUD_BOT_H * k);
    // The four bands must stack to no more than the scaled 1920 floor, or a 9:16 screen would get a
    // design height a pixel off the one `ScalingManager` and the layout sweep both derive from the
    // aspect (720 wide: 47 + 1008 + 47 + 179 = 1281). Per-term rounding is absorbed by the hand.
    const handH   = Math.min(
      Math.round(HAND_H * k),
      Math.round(REFERENCE_H * k) - hudTopH - BOARD_ROWS * cell - hudBotH,
    );
    const hudBotW = Math.round(HUD_BOT_W * k);
    this.boardW = BOARD_COLS * cell;
    this.boardH = BOARD_ROWS * cell;

    // Design height matches the safe-area aspect (fit-to-width leaves no letterbox),
    // clamped so a squat/near-square portrait still gets the classic 9:16 height.
    const aspectH = Math.round(this.designWidth * (availH / Math.max(1, availW)));
    this.designHeight = Math.max(Math.round(REFERENCE_H * k), aspectH);

    // Anchor HUD strips to the edges; ScalingManager keeps the whole layer inside
    // the safe area, so 0…designHeight already maps to the notch-free region.
    const hudTopY = 0;
    const handY   = this.designHeight - handH;
    const hudBotY = handY - hudBotH;

    // Center the board in the gap between the top HUD and the bottom HUD strip.
    const gapTop = hudTopY + hudTopH;
    const gapBot = hudBotY;
    this.boardX = Math.round((this.designWidth - this.boardW) / 2);
    this.boardY = Math.round(gapTop + Math.max(0, (gapBot - gapTop - this.boardH)) / 2);

    const dw = this.designWidth;
    this.hudTopRect         = { x: 0, y: hudTopY, w: dw, h: hudTopH };
    this.boardRect          = { x: this.boardX, y: this.boardY, w: this.boardW, h: this.boardH };
    this.hudBottomLeftRect  = { x: 0,            y: hudBotY, w: hudBotW, h: hudBotH };
    this.hudBottomRightRect = { x: dw - hudBotW, y: hudBotY, w: hudBotW, h: hudBotH };
    this.handRect           = { x: 0, y: handY, w: dw, h: handH };
  }

  // ── Coordinate transforms ──────────────────────────────────────────────────

  gridToScreen(col: number, row: number): { x: number; y: number } {
    if (this.localSide === Side.Bottom) {
      return {
        x: this.boardX + col * this.cellSize + this.cellSize / 2,
        y: this.boardY + (BOARD_ROWS - 1 - row) * this.cellSize + this.cellSize / 2,
      };
    }
    // Player 1: 180° rotation (mirror both axes)
    return {
      x: this.boardX + (BOARD_COLS - 1 - col) * this.cellSize + this.cellSize / 2,
      y: this.boardY + row * this.cellSize + this.cellSize / 2,
    };
  }

  screenToCol(sx: number, _sy: number): number {
    const raw = Math.floor((sx - this.boardX) / this.cellSize);
    return this.localSide === Side.Bottom ? raw : BOARD_COLS - 1 - raw;
  }

  screenToRow(_sx: number, sy: number): number {
    const raw = Math.floor((sy - this.boardY) / this.cellSize);
    return this.localSide === Side.Bottom
      ? BOARD_ROWS - 1 - raw
      : raw;
  }

  isOutsideBoard(sx: number, sy: number): boolean {
    return sx < this.boardX || sx > this.boardX + this.boardW
        || sy < this.boardY || sy > this.boardY + this.boardH;
  }

  playerBaseRect(): Rect {
    if (this.localSide === Side.Bottom) {
      // Rows 0-1 appear at the bottom of the board
      return {
        x: this.boardX + BASE_COLS[0] * this.cellSize,
        y: this.boardY + (BOARD_ROWS - 2) * this.cellSize,
        w: 2 * this.cellSize,
        h: 2 * this.cellSize,
      };
    }
    // Player 1 (joiner): gridToScreen mirrors the row axis, so the local player's
    // own base (game rows 16-17) renders at the BOTTOM — same near-side as the
    // host sees theirs. Must match gridToScreen, or the base sprite / crack / hit
    // outline lands on the wrong castle.
    return {
      x: this.boardX + (BOARD_COLS - 1 - BASE_COLS[1]) * this.cellSize,
      y: this.boardY + (BOARD_ROWS - 2) * this.cellSize,
      w: 2 * this.cellSize,
      h: 2 * this.cellSize,
    };
  }

  enemyBaseRect(): Rect {
    if (this.localSide === Side.Bottom) {
      // Enemy rows 16-17 appear at the top of the board
      return {
        x: this.boardX + BASE_COLS[0] * this.cellSize,
        y: this.boardY,
        w: 2 * this.cellSize,
        h: 2 * this.cellSize,
      };
    }
    // Player 1 (joiner): mirrored, so the enemy base (game rows 0-1) renders at
    // the TOP (far side). Mirror image of the player rect above.
    return {
      x: this.boardX + (BOARD_COLS - 1 - BASE_COLS[1]) * this.cellSize,
      y: this.boardY,
      w: 2 * this.cellSize,
      h: 2 * this.cellSize,
    };
  }

  mirrored(): ILayout {
    const other = this.localSide === Side.Bottom ? Side.Top : Side.Bottom;
    return new PortraitLayout(this.availW, this.availH, other);
  }
}
