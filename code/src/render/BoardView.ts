import * as PIXI from 'pixi.js-legacy';
import { ATTACK_LANES, BASE_COLS, BOARD_COLS, BOARD_ROWS, BOTTOM_BUILDING_ROW } from '../game/config';
import { ObjectPool } from '../cache/ObjectPool';

/** Colors matching the art direction (notebook paper aesthetic) */
const GRID_LINE_COLOR    = 0xc8d8e8;
const GRID_LINE_ALPHA    = 0.4;
const HIGHLIGHT_LANE     = 0x4488ff; // blue tint — valid attack lane
const HIGHLIGHT_BUILDING = 0x44aa44; // green tint — valid building slot
const HIGHLIGHT_ALPHA    = 0.18;
const HIGHLIGHT_METEOR   = 0xff4422; // red tint — meteor targeting
const SELECTED_CELL      = 0xffcc00; // yellow — hovered/selected cell

export class BoardView {
  readonly container: PIXI.Container;

  cellWidth:  number;
  cellHeight: number;
  offsetX:    number;
  offsetY:    number;

  /** Called when user taps/clicks a board cell during placement mode. */
  onCellTap: ((col: number, row: number) => void) | null = null;

  private readonly highlightLayer: PIXI.Graphics;
  private readonly overlay: PIXI.Graphics; // transparent interactive hit area

  private readonly meteorPool = new ObjectPool<PIXI.Graphics>(
    () => new PIXI.Graphics(),
    (gfx) => { gfx.clear(); gfx.alpha = 1; gfx.removeFromParent(); },
    3,
  );

  constructor(screenWidth: number, screenHeight: number) {
    this.container = new PIXI.Container();

    // Portrait layout: board takes full screen width, centered vertically
    this.cellWidth  = Math.floor(screenWidth / BOARD_COLS);
    this.cellHeight = Math.floor(screenHeight / BOARD_ROWS);
    this.offsetX    = 0;
    this.offsetY    = 0;

    this.highlightLayer = new PIXI.Graphics();
    this.overlay        = new PIXI.Graphics();

    this.draw();
    this.container.addChild(this.highlightLayer);
    this.buildOverlay();
  }

  // ─── Coordinate conversion ────────────────────────────────────────────────

  /** Convert grid position to screen pixel center */
  gridToScreen(col: number, rowExact: number): { x: number; y: number } {
    return {
      x: this.offsetX + col * this.cellWidth + this.cellWidth / 2,
      y: this.offsetY + rowExact * this.cellHeight + this.cellHeight / 2,
    };
  }

  /** Convert screen pixel to grid cell */
  screenToGrid(x: number, y: number): { col: number; row: number } {
    return {
      col: Math.floor((x - this.offsetX) / this.cellWidth),
      row: Math.floor((y - this.offsetY) / this.cellHeight),
    };
  }

  screenToCol(x: number): number {
    return Math.floor((x - this.offsetX) / this.cellWidth);
  }

  screenToRow(y: number): number {
    return Math.floor((y - this.offsetY) / this.cellHeight);
  }

  /**
   * Returns the screen-space rect of the bottom player's base (cols 5-6, rows 0-1).
   * Used by GameRenderer to detect upgrade drag drop target.
   */
  getPlayerBaseRect(): { x: number; y: number; w: number; h: number } {
    const minCol = BASE_COLS[0];
    const maxCol = BASE_COLS[1];
    return {
      x: this.offsetX + minCol * this.cellWidth,
      y: this.offsetY + BOTTOM_BUILDING_ROW * this.cellHeight,
      w: (maxCol - minCol + 1) * this.cellWidth,
      h: 2 * this.cellHeight,
    };
  }

  /** Highlight the player's base as an upgrade drop target (gold tint). */
  showBaseUpgradeHighlight(active: boolean): void {
    this.highlightLayer.clear();
    if (!active) return;
    const rect = this.getPlayerBaseRect();
    this.highlightLayer.beginFill(0xffcc00, 0.3);
    this.highlightLayer.lineStyle(2, 0xffcc00, 0.8);
    this.highlightLayer.drawRect(rect.x, rect.y, rect.w, rect.h);
    this.highlightLayer.endFill();
  }

  isOutsideBoard(x: number, y: number): boolean {
    return (
      x < this.offsetX ||
      x > this.offsetX + BOARD_COLS * this.cellWidth ||
      y < this.offsetY ||
      y > this.offsetY + BOARD_ROWS * this.cellHeight
    );
  }

  // ─── Placement highlights ─────────────────────────────────────────────────

  /** Highlight all valid attack lane columns (blue). */
  showLaneHighlights(): void {
    this.highlightLayer.clear();
    for (const col of ATTACK_LANES) {
      this.highlightLayer.beginFill(HIGHLIGHT_LANE, HIGHLIGHT_ALPHA);
      this.highlightLayer.drawRect(
        this.offsetX + col * this.cellWidth,
        this.offsetY,
        this.cellWidth,
        BOARD_ROWS * this.cellHeight,
      );
      this.highlightLayer.endFill();
    }
    this.overlay.interactive = true;
  }

  /**
   * Highlight unit lane columns with per-column state:
   * - blocked (spawn row occupied) → red
   * - hovered → brighter blue
   * - normal → standard blue
   */
  showUnitLaneHighlights(
    lanes: number[],
    blockedCols: Set<number>,
    hoveredCol: number,
  ): void {
    this.highlightLayer.clear();
    for (const col of lanes) {
      const isBlocked = blockedCols.has(col);
      const isHovered = col === hoveredCol;
      const color = isBlocked ? 0xdd3333 : (isHovered ? 0x2266ff : HIGHLIGHT_LANE);
      const alpha = isBlocked ? 0.28 : (isHovered ? 0.30 : HIGHLIGHT_ALPHA);
      this.highlightLayer.beginFill(color, alpha);
      this.highlightLayer.drawRect(
        this.offsetX + col * this.cellWidth,
        this.offsetY,
        this.cellWidth,
        BOARD_ROWS * this.cellHeight,
      );
      this.highlightLayer.endFill();
    }
    this.overlay.interactive = true;
  }

  /** Highlight a set of building slot columns/rows (green). */
  showBuildingHighlights(validCols: number[], buildingRow: number): void {
    this.highlightLayer.clear();
    for (const col of validCols) {
      this.highlightLayer.beginFill(HIGHLIGHT_BUILDING, HIGHLIGHT_ALPHA);
      this.highlightLayer.drawRect(
        this.offsetX + col * this.cellWidth,
        this.offsetY + buildingRow * this.cellHeight,
        this.cellWidth,
        this.cellHeight,
      );
      this.highlightLayer.endFill();
    }
    this.overlay.interactive = true;
  }

  /** Highlight the whole board for meteor targeting (red tint). */
  showMeteorHighlights(): void {
    this.highlightLayer.clear();
    this.highlightLayer.beginFill(HIGHLIGHT_METEOR, 0.08);
    this.highlightLayer.drawRect(
      this.offsetX,
      this.offsetY,
      BOARD_COLS * this.cellWidth,
      BOARD_ROWS * this.cellHeight,
    );
    this.highlightLayer.endFill();
    this.overlay.interactive = true;
  }

  /** Remove all placement highlights and disable tap capture. */
  clearHighlights(): void {
    this.highlightLayer.clear();
    this.overlay.interactive = false;
  }

  // ─── One-shot effects ─────────────────────────────────────────────────────

  playMeteorEffect(col: number, row: number): void {
    const pos = this.gridToScreen(col, row);
    const gfx = this.meteorPool.acquire();
    gfx.lineStyle(4, 0xff0000);
    gfx.drawRect(
      pos.x - this.cellWidth,
      pos.y - this.cellHeight,
      this.cellWidth * 2,
      this.cellHeight * 2,
    );
    this.container.addChild(gfx);

    let frames = 30;
    const tick = (): void => {
      gfx.alpha = frames / 30;
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        this.meteorPool.release(gfx); // resetter calls removeFromParent + clear
      }
    };
    PIXI.Ticker.shared.add(tick);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private draw(): void {
    const gfx = new PIXI.Graphics();

    // Grid lines
    gfx.lineStyle(1, GRID_LINE_COLOR, GRID_LINE_ALPHA);
    for (let col = 0; col <= BOARD_COLS; col++) {
      const x = this.offsetX + col * this.cellWidth;
      gfx.moveTo(x, this.offsetY);
      gfx.lineTo(x, this.offsetY + BOARD_ROWS * this.cellHeight);
    }
    for (let row = 0; row <= BOARD_ROWS; row++) {
      const y = this.offsetY + row * this.cellHeight;
      gfx.moveTo(this.offsetX, y);
      gfx.lineTo(this.offsetX + BOARD_COLS * this.cellWidth, y);
    }

    this.container.addChild(gfx);
  }

  private buildOverlay(): void {
    // Transparent rect that covers the board and captures pointer events
    this.overlay.beginFill(0xffffff, 0.001);
    this.overlay.drawRect(
      this.offsetX,
      this.offsetY,
      BOARD_COLS * this.cellWidth,
      BOARD_ROWS * this.cellHeight,
    );
    this.overlay.endFill();
    this.overlay.interactive = false; // enabled only during placement mode
    this.overlay.cursor = 'crosshair';

    this.overlay.on('pointertap', (e: PIXI.FederatedPointerEvent) => {
      if (!this.onCellTap) return;
      const local = e.getLocalPosition(this.overlay);
      const { col, row } = this.screenToGrid(local.x, local.y);
      if (col >= 0 && col < BOARD_COLS && row >= 0 && row < BOARD_ROWS) {
        this.onCellTap(col, row);
      }
    });

    this.container.addChild(this.overlay);
  }
}
