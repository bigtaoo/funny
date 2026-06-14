/**
 * sketchDemo.ts — standalone brush-stroke sampler for eyeballing the pen.
 *
 * Booted via the `?sketch` URL param (see entries/web.ts) instead of the game,
 * so the procedural look can be validated in isolation without touching the
 * battle scene. Draws the pen repertoire plus a preview of the baked board
 * background.
 */
import * as PIXI from 'pixi.js-legacy';
import { drawSketchDemo, SketchPen } from './sketch';
import { palette } from './theme';

export function startSketchDemo(canvas: HTMLCanvasElement): void {
  const w = window.innerWidth;
  const h = window.innerHeight;

  const app = new PIXI.Application({
    width:           w,
    height:          h,
    backgroundColor: palette.paper,
    view:            canvas,
    antialias:       true,
    resolution:      window.devicePixelRatio || 1,
    autoDensity:     true,
  });

  // Left: pen repertoire sampler.
  const sampler = new PIXI.Graphics();
  drawSketchDemo(sampler, Math.min(640, w), h);
  app.stage.addChild(sampler);

  // Right: a mock ruled-board patch like the in-game baked background.
  const boardX = Math.min(660, w * 0.55);
  const board = new PIXI.Graphics();
  board.position.set(boardX, 60);
  const bw = Math.min(420, w - boardX - 20);
  const bh = Math.min(560, h - 120);
  board.beginFill(palette.paperShade, 1);
  board.drawRect(0, 0, bw, bh);
  board.endFill();
  const cell = 44;
  const pen = new SketchPen(board, 0x9e3779b1);
  for (let x = 0; x <= bw; x += cell) {
    pen.line(x, 0, x, Math.floor(bh / cell) * cell, { color: palette.ruleLine, width: 1.1, jitter: 0.6, taper: 0.85, double: false });
  }
  for (let y = 0; y <= bh; y += cell) {
    pen.line(0, y, Math.floor(bw / cell) * cell, y, { color: palette.ruleLine, width: 1.1, jitter: 0.6, taper: 0.85, double: false });
  }
  pen.rect(1, 1, Math.floor(bw / cell) * cell - 2, Math.floor(bh / cell) * cell - 2, { color: palette.pencil, width: 2, jitter: 1.0 });
  app.stage.addChild(board);
}
