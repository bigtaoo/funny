import { Side } from '../game';

export type Orientation = 'portrait' | 'landscape';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * ILayout — coordinate transform + layout geometry for one orientation/player combo.
 *
 * All coordinates are in **design space** (portrait: 1080×1920, landscape: 1920×1080).
 * The ScalingManager maps design space → actual screen pixels via a single scale factor.
 *
 * The game logic always runs in portrait coordinates (col 0-11, row 0-17).
 * ILayout's gridToScreen / screenToCol / screenToRow handle the mapping so the
 * render layer is fully orientation-agnostic.
 */
export interface ILayout {
  readonly orientation:  Orientation;
  /** Which side the local player is on. MVP: always Side.Bottom. */
  readonly localSide:    Side;
  readonly cellSize:     number;
  readonly designWidth:  number;
  readonly designHeight: number;

  // ── Layout rects (design space) ────────────────────────────────────────────
  readonly boardRect:          Rect;  // The 12×18 (or 18×12) grid area
  readonly hudTopRect:         Rect;  // Top HUD strip (timer / enemy HP / settings)
  readonly hudBottomLeftRect:  Rect;  // Ink + own HP
  readonly hudBottomRightRect: Rect;  // Upgrade button
  readonly handRect:           Rect;  // Hand card area (always bottom-center)

  // ── Card dimensions (design space) ─────────────────────────────────────────
  readonly cardWidth:  number;
  readonly cardHeight: number;
  readonly cardMargin: number;

  // ── Coordinate transforms ──────────────────────────────────────────────────

  /**
   * Logic (col, row) → design-space pixel center of that cell.
   * Both col and row may be floats (smooth unit positions).
   */
  gridToScreen(col: number, row: number): { x: number; y: number };

  /**
   * Design-space pointer position → logic column (integer-snapped, unclamped).
   * Negative or out-of-range values are possible when outside the board.
   */
  screenToCol(sx: number, sy: number): number;

  /** Design-space pointer position → logic row (integer-snapped, unclamped). */
  screenToRow(sx: number, sy: number): number;

  /** True if the design-space point is outside the board rect. */
  isOutsideBoard(sx: number, sy: number): boolean;

  /** Design-space rect occupied by the local player's base (for upgrade drag). */
  playerBaseRect(): Rect;

  /** Design-space rect occupied by the enemy's base. */
  enemyBaseRect(): Rect;
}
