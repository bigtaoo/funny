import { BOARD_COLS, BOARD_ROWS, BASE_COLS } from '../game/config';
import { Side } from '../game';
import { ILayout, Orientation, Rect } from './ILayout';

// ── Design constants ──────────────────────────────────────────────────────────

const DESIGN_W   = 1080;
const CELL       = 84;
const HUD_TOP_H  = 70;
const HUD_BOT_H  = 70;
const HAND_H     = 268;
const BOARD_W    = BOARD_COLS * CELL;                   // 1008
const BOARD_H    = BOARD_ROWS * CELL;                   // 1512
const BOARD_X    = (DESIGN_W - BOARD_W) / 2;            // 36 — center the grid horizontally

/**
 * Classic 9:16 design height. On screens with exactly this aspect the layout is
 * identical to the historical fixed 1080×1920 board. Taller screens (iPhone 13 =
 * ~9:19.5, etc.) get a proportionally taller design space so the game fills the
 * full height instead of being letterboxed with dead bands top and bottom.
 */
const REFERENCE_H = 1920;

/**
 * Portrait layout — design width fixed at 1080; design height follows the aspect
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
  readonly cellSize    = CELL;
  readonly designWidth  = DESIGN_W;
  readonly designHeight: number;

  readonly boardRect:          Rect;
  readonly hudTopRect:         Rect;
  readonly hudBottomLeftRect:  Rect;
  readonly hudBottomRightRect: Rect;
  readonly handRect:           Rect;

  readonly cardWidth  = 155;
  readonly cardHeight = 190;
  readonly cardMargin = 8;

  // Board origin in design space (instance-level — depends on the dynamic height).
  private readonly boardX: number;
  private readonly boardY: number;

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

    // Design height matches the safe-area aspect (fit-to-width leaves no letterbox),
    // clamped so a squat/near-square portrait still gets the classic 1920 height.
    const aspectH = Math.round(DESIGN_W * (availH / Math.max(1, availW)));
    this.designHeight = Math.max(REFERENCE_H, aspectH);

    // Anchor HUD strips to the edges; ScalingManager keeps the whole layer inside
    // the safe area, so 0…designHeight already maps to the notch-free region.
    const hudTopY = 0;
    const handY   = this.designHeight - HAND_H;
    const hudBotY = handY - HUD_BOT_H;

    // Center the board in the gap between the top HUD and the bottom HUD strip.
    const gapTop = hudTopY + HUD_TOP_H;
    const gapBot = hudBotY;
    this.boardX = BOARD_X;
    this.boardY = Math.round(gapTop + Math.max(0, (gapBot - gapTop - BOARD_H)) / 2);

    this.hudTopRect         = { x: 0, y: hudTopY, w: DESIGN_W, h: HUD_TOP_H };
    this.boardRect          = { x: this.boardX, y: this.boardY, w: BOARD_W, h: BOARD_H };
    this.hudBottomLeftRect  = { x: 0,              y: hudBotY, w: 360, h: HUD_BOT_H };
    this.hudBottomRightRect = { x: DESIGN_W - 360, y: hudBotY, w: 360, h: HUD_BOT_H };
    this.handRect           = { x: 0, y: handY, w: DESIGN_W, h: HAND_H };
  }

  // ── Coordinate transforms ──────────────────────────────────────────────────

  gridToScreen(col: number, row: number): { x: number; y: number } {
    if (this.localSide === Side.Bottom) {
      return {
        x: this.boardX + col * CELL + CELL / 2,
        y: this.boardY + (BOARD_ROWS - 1 - row) * CELL + CELL / 2,
      };
    }
    // Player 1: 180° rotation (mirror both axes)
    return {
      x: this.boardX + (BOARD_COLS - 1 - col) * CELL + CELL / 2,
      y: this.boardY + row * CELL + CELL / 2,
    };
  }

  screenToCol(sx: number, _sy: number): number {
    const raw = Math.floor((sx - this.boardX) / CELL);
    return this.localSide === Side.Bottom ? raw : BOARD_COLS - 1 - raw;
  }

  screenToRow(_sx: number, sy: number): number {
    const raw = Math.floor((sy - this.boardY) / CELL);
    return this.localSide === Side.Bottom
      ? BOARD_ROWS - 1 - raw
      : raw;
  }

  isOutsideBoard(sx: number, sy: number): boolean {
    return sx < this.boardX || sx > this.boardX + BOARD_W
        || sy < this.boardY || sy > this.boardY + BOARD_H;
  }

  playerBaseRect(): Rect {
    if (this.localSide === Side.Bottom) {
      // Rows 0-1 appear at the bottom of the board
      return {
        x: this.boardX + BASE_COLS[0] * CELL,
        y: this.boardY + (BOARD_ROWS - 2) * CELL,
        w: 2 * CELL,
        h: 2 * CELL,
      };
    }
    // Player 1 (joiner): gridToScreen mirrors the row axis, so the local player's
    // own base (game rows 16-17) renders at the BOTTOM — same near-side as the
    // host sees theirs. Must match gridToScreen, or the base sprite / crack / hit
    // outline lands on the wrong castle.
    return {
      x: this.boardX + (BOARD_COLS - 1 - BASE_COLS[1]) * CELL,
      y: this.boardY + (BOARD_ROWS - 2) * CELL,
      w: 2 * CELL,
      h: 2 * CELL,
    };
  }

  enemyBaseRect(): Rect {
    if (this.localSide === Side.Bottom) {
      // Enemy rows 16-17 appear at the top of the board
      return {
        x: this.boardX + BASE_COLS[0] * CELL,
        y: this.boardY,
        w: 2 * CELL,
        h: 2 * CELL,
      };
    }
    // Player 1 (joiner): mirrored, so the enemy base (game rows 0-1) renders at
    // the TOP (far side). Mirror image of the player rect above.
    return {
      x: this.boardX + (BOARD_COLS - 1 - BASE_COLS[1]) * CELL,
      y: this.boardY,
      w: 2 * CELL,
      h: 2 * CELL,
    };
  }

  mirrored(): ILayout {
    const other = this.localSide === Side.Bottom ? Side.Top : Side.Bottom;
    return new PortraitLayout(this.availW, this.availH, other);
  }
}
