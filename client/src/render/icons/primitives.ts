/**
 * primitives.ts — shared low-level ink helpers used by several icon categories.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen, StrokeOpts } from '../sketch';

/** One filled gold coin (flat pale-gold fill + ink-gold rim + faint shine) for the pile icons. */
export function inkCoin(g: PIXI.Graphics, pen: SketchPen, cx: number, cy: number, r: number): void {
  g.beginFill(0xf3d873, 1);
  g.lineStyle(0);
  g.drawCircle(cx, cy, r);
  g.endFill();
  const w = Math.max(1.2, r * 0.18);
  pen.circle(cx, cy, r, { color: 0xcc9900, width: w, jitter: 0.4, taper: 0.95, double: false });
  pen.line(cx - r * 0.34, cy - r * 0.12, cx + r * 0.30, cy - r * 0.12,
    { color: 0xcc9900, width: w * 0.6, jitter: 0.15, taper: 0.3, double: false, alpha: 0.55 });
}

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
