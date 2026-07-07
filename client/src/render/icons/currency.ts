/**
 * currency.ts — coin + escalating recharge-tier treasure glyphs.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from '../sketch';
import { inkCoin } from './primitives';

/** Coin — two concentric ink rings + a small centre sparkle (the shine). */
export function drawCoin(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x607);
  const w = Math.max(1.5, s * 0.06);
  const cx = s / 2, cy = s / 2, r = s * 0.34;

  pen.circle(cx, cy, r, { color, width: w, jitter: 0.5, taper: 0.95, double: false });
  pen.circle(cx, cy, r * 0.64, { color, width: w * 0.7, jitter: 0.4, taper: 0.95, double: false });

  // 4-point sparkle in the centre — short tapered rays read as a coin's shine.
  const sp = s * 0.13;
  pen.line(cx - sp, cy, cx + sp, cy, { color, width: w * 0.7, jitter: 0.2, taper: 0.25, double: false });
  pen.line(cx, cy - sp, cx, cy + sp, { color, width: w * 0.7, jitter: 0.2, taper: 0.25, double: false });
}

/** Coins — a small cluster of three gold coins (tier 2). */
export function drawCoins(g: PIXI.Graphics, s: number, _color: number): void {
  const pen = new SketchPen(g, 0x60c1);
  const r = s * 0.19;
  inkCoin(g, pen, s * 0.35, s * 0.58, r);   // back-left
  inkCoin(g, pen, s * 0.65, s * 0.58, r);   // back-right
  inkCoin(g, pen, s * 0.50, s * 0.36, r);   // front-top (drawn last → in front)
}

/** Coin stack — a six-coin pyramid pile (tier 3, best value). */
export function drawCoinStack(g: PIXI.Graphics, s: number, _color: number): void {
  const pen = new SketchPen(g, 0x60c2);
  const r = s * 0.145;
  inkCoin(g, pen, s * 0.29, s * 0.68, r);   // bottom row (drawn first → behind)
  inkCoin(g, pen, s * 0.50, s * 0.68, r);
  inkCoin(g, pen, s * 0.71, s * 0.68, r);
  inkCoin(g, pen, s * 0.39, s * 0.50, r);   // middle row
  inkCoin(g, pen, s * 0.61, s * 0.50, r);
  inkCoin(g, pen, s * 0.50, s * 0.32, r);   // top
}

/** Coin sack — a cinched money pouch stamped with a coin, coins spilling at the base (tier 4). */
export function drawCoinSack(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x60c3);
  const w = Math.max(1.5, s * 0.05);
  const body = [
    s * 0.36, s * 0.34, s * 0.22, s * 0.54, s * 0.24, s * 0.72, s * 0.34, s * 0.83,
    s * 0.66, s * 0.83, s * 0.76, s * 0.72, s * 0.78, s * 0.54, s * 0.64, s * 0.34,
  ];
  g.beginFill(0xf6efdc, 1);
  g.lineStyle(0);
  g.drawPolygon(body);
  g.endFill();
  pen.stroke([
    { x: s * 0.36, y: s * 0.34 }, { x: s * 0.22, y: s * 0.54 }, { x: s * 0.24, y: s * 0.72 },
    { x: s * 0.34, y: s * 0.83 }, { x: s * 0.66, y: s * 0.83 }, { x: s * 0.76, y: s * 0.72 },
    { x: s * 0.78, y: s * 0.54 }, { x: s * 0.64, y: s * 0.34 },
  ], { color, width: w, jitter: 0.5, taper: 0.95, double: false });
  // Cinched neck: a tie line under a frilled top.
  pen.line(s * 0.36, s * 0.34, s * 0.64, s * 0.34, { color, width: w, jitter: 0.4, taper: 0.9, double: false });
  pen.stroke([
    { x: s * 0.40, y: s * 0.34 }, { x: s * 0.45, y: s * 0.24 }, { x: s * 0.50, y: s * 0.30 },
    { x: s * 0.55, y: s * 0.24 }, { x: s * 0.60, y: s * 0.34 },
  ], { color, width: w * 0.8, jitter: 0.4, taper: 0.9, double: false });
  // Coin stamped on the pouch.
  inkCoin(g, pen, s * 0.50, s * 0.58, s * 0.12);
  // Two coins spilling at the base (front).
  inkCoin(g, pen, s * 0.33, s * 0.86, s * 0.09);
  inkCoin(g, pen, s * 0.62, s * 0.87, s * 0.08);
}

/** Coin chest — an open treasure chest brimming with coins (tier 5, top). */
export function drawCoinChest(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x60c4);
  const w = Math.max(1.5, s * 0.05);
  const bodyL = s * 0.20, bodyR = s * 0.80, bodyT = s * 0.52, bodyB = s * 0.82;
  // Chest body (front box).
  g.beginFill(0xf6efdc, 1);
  g.lineStyle(0);
  g.drawRect(bodyL, bodyT, bodyR - bodyL, bodyB - bodyT);
  g.endFill();
  pen.stroke([
    { x: bodyL, y: bodyT }, { x: bodyL, y: bodyB }, { x: bodyR, y: bodyB },
    { x: bodyR, y: bodyT }, { x: bodyL, y: bodyT },
  ], { color, width: w, jitter: 0.4, taper: 0.95, double: false });
  // Open lid tilted back above the body.
  pen.stroke([
    { x: bodyL, y: bodyT }, { x: s * 0.28, y: s * 0.30 }, { x: s * 0.72, y: s * 0.30 }, { x: bodyR, y: bodyT },
  ], { color, width: w, jitter: 0.4, taper: 0.95, double: false });
  // Lock plate + keyhole on the front.
  pen.stroke([
    { x: s * 0.455, y: s * 0.62 }, { x: s * 0.455, y: s * 0.74 },
    { x: s * 0.545, y: s * 0.74 }, { x: s * 0.545, y: s * 0.62 }, { x: s * 0.455, y: s * 0.62 },
  ], { color, width: w * 0.7, jitter: 0.3, taper: 0.9, double: false });
  pen.circle(s * 0.50, s * 0.66, s * 0.016, { color, width: w * 0.6, jitter: 0.2, taper: 0.9, double: false });
  // Coins brimming over the rim (drawn last → in front).
  inkCoin(g, pen, s * 0.34, s * 0.50, s * 0.11);
  inkCoin(g, pen, s * 0.66, s * 0.50, s * 0.11);
  inkCoin(g, pen, s * 0.50, s * 0.44, s * 0.12);
}
