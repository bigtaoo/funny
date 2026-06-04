import * as PIXI from 'pixi.js-legacy';
import { ATTACK_LANES, BOARD_COLS, BOARD_ROWS } from '../game/config';
import { ILayout, Rect } from '../layout/ILayout';
import { ObjectPool } from '../cache/ObjectPool';
import baseTexUrl from '../assets/game_base.png';

/** Colors matching the art direction (notebook paper aesthetic) */
const GRID_LINE_COLOR    = 0xc8d8e8;
const GRID_LINE_ALPHA    = 0.4;
const HIGHLIGHT_LANE     = 0x4488ff; // blue tint — valid attack lane
const HIGHLIGHT_BUILDING = 0x44aa44; // green tint — valid building slot
const HIGHLIGHT_ALPHA    = 0.18;
const HIGHLIGHT_METEOR   = 0xff4422; // red tint — meteor targeting

export class BoardView {
  readonly container: PIXI.Container;

  private readonly layout: ILayout;
  private readonly highlightLayer: PIXI.Graphics;

  private readonly meteorPool = new ObjectPool<PIXI.Graphics>(
    () => new PIXI.Graphics(),
    (gfx) => { gfx.clear(); gfx.alpha = 1; gfx.removeFromParent(); },
    3,
  );

  constructor(layout: ILayout) {
    this.layout    = layout;
    this.container = new PIXI.Container();

    this.highlightLayer = new PIXI.Graphics();

    this.drawGrid();
    this.drawBases(layout);
    this.container.addChild(this.highlightLayer);
  }

  // ── Coordinate helpers (delegate to ILayout) ──────────────────────────────

  gridToScreen(col: number, rowExact: number): { x: number; y: number } {
    return this.layout.gridToScreen(col, rowExact);
  }

  screenToCol(sx: number, sy: number): number {
    return this.layout.screenToCol(sx, sy);
  }

  screenToRow(sx: number, sy: number): number {
    return this.layout.screenToRow(sx, sy);
  }

  isOutsideBoard(sx: number, sy: number): boolean {
    return this.layout.isOutsideBoard(sx, sy);
  }

  getPlayerBaseRect(): Rect {
    return this.layout.playerBaseRect();
  }

  // ── Placement highlights ──────────────────────────────────────────────────

  /**
   * Highlight unit lane columns with per-column state:
   * - blocked (spawn row occupied) → red
   * - hovered → brighter blue
   * - normal  → standard blue
   *
   * Works for both portrait (vertical stripes) and landscape (horizontal bands).
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
      const r = this.laneRect(col);
      this.highlightLayer.drawRect(r.x, r.y, r.w, r.h);
      this.highlightLayer.endFill();
    }
  }

  showBuildingHighlights(validCols: number[], buildingRow: number): void {
    this.highlightLayer.clear();
    for (const col of validCols) {
      const pos = this.layout.gridToScreen(col, buildingRow);
      const cs  = this.layout.cellSize;
      this.highlightLayer.beginFill(HIGHLIGHT_BUILDING, HIGHLIGHT_ALPHA);
      this.highlightLayer.drawRect(pos.x - cs / 2, pos.y - cs / 2, cs, cs);
      this.highlightLayer.endFill();
    }
  }

  /**
   * Show a 2×2 meteor target preview centered at (col, row) in game coords.
   * Draws a subtle full-board red tint + a bright 2×2 area.
   * Out-of-bounds cells are silently skipped.
   */
  showMeteorTargetHighlight(col: number, row: number): void {
    this.highlightLayer.clear();

    // Subtle full-board tint so the player knows meteor is selected
    const r = this.layout.boardRect;
    this.highlightLayer.beginFill(HIGHLIGHT_METEOR, 0.06);
    this.highlightLayer.drawRect(r.x, r.y, r.w, r.h);
    this.highlightLayer.endFill();

    // Bright 2×2 target area
    const cs = this.layout.cellSize;
    for (let dc = 0; dc <= 1; dc++) {
      for (let dr = 0; dr <= 1; dr++) {
        const tc = col + dc;
        const tr = row + dr;
        if (tc < 0 || tc >= BOARD_COLS) continue;
        if (tr < 0 || tr >= BOARD_ROWS)  continue;
        const pos = this.layout.gridToScreen(tc, tr);
        this.highlightLayer.lineStyle(2, HIGHLIGHT_METEOR, 0.9);
        this.highlightLayer.beginFill(HIGHLIGHT_METEOR, 0.40);
        this.highlightLayer.drawRect(pos.x - cs / 2, pos.y - cs / 2, cs, cs);
        this.highlightLayer.endFill();
      }
    }
  }

  showBaseUpgradeHighlight(active: boolean): void {
    this.highlightLayer.clear();
    if (!active) return;
    const rect = this.layout.playerBaseRect();
    this.highlightLayer.beginFill(0xffcc00, 0.3);
    this.highlightLayer.lineStyle(2, 0xffcc00, 0.8);
    this.highlightLayer.drawRect(rect.x, rect.y, rect.w, rect.h);
    this.highlightLayer.endFill();
  }

  clearHighlights(): void {
    this.highlightLayer.clear();
  }

  // ── One-shot effects ──────────────────────────────────────────────────────

  playMeteorEffect(col: number, row: number): void {
    const pos = this.layout.gridToScreen(col, row);
    const cs  = this.layout.cellSize;
    const gfx = this.meteorPool.acquire();
    gfx.lineStyle(4, 0xff0000);
    gfx.drawRect(pos.x - cs, pos.y - cs, cs * 2, cs * 2);
    this.container.addChild(gfx);

    let frames = 30;
    const tick = (): void => {
      gfx.alpha = frames / 30;
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        this.meteorPool.release(gfx);
      }
    };
    PIXI.Ticker.shared.add(tick);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Returns the screen-space rect for a single game-column lane.
   *
   * Portrait:  lane = vertical stripe (full board height, one column wide).
   * Landscape: lane = horizontal band (full board width, one column tall — because
   *            game cols map to screen Y in landscape).
   */
  private laneRect(gameCol: number): Rect {
    const r    = this.layout.boardRect;
    const cell = this.layout.cellSize;
    if (this.layout.orientation === 'portrait') {
      return { x: r.x + gameCol * cell, y: r.y, w: cell, h: r.h };
    }
    // In landscape, game col → screen Y band
    return { x: r.x, y: r.y + gameCol * cell, w: r.w, h: cell };
  }

  private drawBases(layout: ILayout): void {
    const baseTex = PIXI.Texture.from(baseTexUrl as string);

    const addBase = (rect: Rect, mirror: boolean): void => {
      const s = new PIXI.Sprite(baseTex);
      s.anchor.set(0.5);
      s.x = rect.x + rect.w / 2;
      s.y = rect.y + rect.h / 2;
      s.width  = rect.w;
      s.height = rect.h;
      if (mirror) {
        // Portrait: enemy is above → flip vertically
        // Landscape: enemy is to the right → flip horizontally
        if (layout.orientation === 'landscape') {
          s.scale.x *= -1;
        } else {
          s.scale.y *= -1;
        }
      }
      this.container.addChild(s);
    };

    addBase(layout.playerBaseRect(), false);
    addBase(layout.enemyBaseRect(),  true);
  }

  private drawGrid(): void {
    const gfx  = new PIXI.Graphics();
    const r    = this.layout.boardRect;
    const cell = this.layout.cellSize;

    // In portrait: BOARD_COLS cols × BOARD_ROWS rows
    // In landscape: BOARD_ROWS cols × BOARD_COLS rows (transposed display)
    const numCols = this.layout.orientation === 'portrait' ? BOARD_COLS : BOARD_ROWS;
    const numRows = this.layout.orientation === 'portrait' ? BOARD_ROWS : BOARD_COLS;

    // Board background fill — makes the board area distinct from the surrounding margins
    gfx.beginFill(0xE8E4DB, 1.0);
    gfx.drawRect(r.x, r.y, r.w, r.h);
    gfx.endFill();

    // Grid lines
    gfx.lineStyle(1, GRID_LINE_COLOR, GRID_LINE_ALPHA);

    for (let c = 0; c <= numCols; c++) {
      const x = r.x + c * cell;
      gfx.moveTo(x, r.y);
      gfx.lineTo(x, r.y + numRows * cell);
    }
    for (let rr = 0; rr <= numRows; rr++) {
      const y = r.y + rr * cell;
      gfx.moveTo(r.x, y);
      gfx.lineTo(r.x + numCols * cell, y);
    }

    // Board border — clear outline to distinguish board from margins
    gfx.lineStyle(2, 0xaaaaaa, 0.6);
    gfx.drawRect(r.x, r.y, r.w, r.h);

    this.container.addChild(gfx);
  }

}
