import * as PIXI from 'pixi.js-legacy';
import { BOARD_COLS, BOARD_ROWS } from '../game/config';

/** Colors matching the art direction (notebook paper aesthetic) */
const GRID_LINE_COLOR = 0xc8d8e8;
const GRID_LINE_ALPHA = 0.4;
const BASE_COLOR = 0xe8d8c8;
const BUILDING_LANE_COLOR = 0xd8e8d8;

export class BoardView {
  readonly container: PIXI.Container;

  cellWidth: number;
  cellHeight: number;
  offsetX: number;
  offsetY: number;

  constructor(screenWidth: number, screenHeight: number) {
    this.container = new PIXI.Container();

    // Portrait layout: board takes full screen width, centered vertically
    this.cellWidth = Math.floor(screenWidth / BOARD_COLS);
    this.cellHeight = Math.floor(screenHeight / BOARD_ROWS);
    this.offsetX = 0;
    this.offsetY = 0;

    this.draw();
  }

  /** Convert grid position to screen pixel center */
  gridToScreen(col: number, row: number): { x: number; y: number } {
    return {
      x: this.offsetX + col * this.cellWidth + this.cellWidth / 2,
      y: this.offsetY + row * this.cellHeight + this.cellHeight / 2,
    };
  }

  /** Convert screen pixel to grid position */
  screenToGrid(x: number, y: number): { col: number; row: number } {
    return {
      col: Math.floor((x - this.offsetX) / this.cellWidth),
      row: Math.floor((y - this.offsetY) / this.cellHeight),
    };
  }

  playMeteorEffect(col: number, row: number): void {
    const pos = this.gridToScreen(col, row);
    const gfx = new PIXI.Graphics();
    gfx.lineStyle(4, 0xff0000);
    gfx.drawRect(pos.x - this.cellWidth, pos.y - this.cellHeight, this.cellWidth * 2, this.cellHeight * 2);
    this.container.addChild(gfx);

    // Fade out after 0.5s (30 frames)
    let frames = 30;
    const tick = (): void => {
      gfx.alpha = frames / 30;
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        this.container.removeChild(gfx);
        gfx.destroy();
      }
    };
    PIXI.Ticker.shared.add(tick);
  }

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
}
