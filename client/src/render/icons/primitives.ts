/**
 * primitives.ts — shared low-level ink helpers used by several icon categories.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen, StrokeOpts } from '../sketch';

/**
 * Square-wave crenellation along the top edge `[x0,x1]` at height `yBase`,
 * merlons rising `depth` above it. Used for castle battlements.
 */
export function battlement(
  pen: SketchPen, x0: number, x1: number, yBase: number,
  depth: number, merlons: number, opt: StrokeOpts,
): void {
  const total = merlons * 2 - 1;
  const seg = (x1 - x0) / total;
  const pts = [{ x: x0, y: yBase }];
  let cur = x0;
  let high = true;
  for (let i = 0; i < total; i++) {
    const yy = high ? yBase - depth : yBase;
    pts.push({ x: cur, y: yy });
    cur += seg;
    pts.push({ x: cur, y: yy });
    high = !high;
  }
  pen.stroke(pts, opt);
}
