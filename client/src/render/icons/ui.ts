/**
 * ui.ts — general UI glyphs: results actions (swords / replay / share / home),
 * hub tabs (tag / capsule / cards), rarity star, lock, medal, zoom, gift, and the
 * common dingbats (close / check / play).
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from '../sketch';

/** Crossed swords (play again / re-battle) — two diagonal blades with hilts. */
export function drawSwords(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x5c0d);
  const w = Math.max(1.5, s * 0.05);
  // Two blades crossing near centre.
  pen.line(s * 0.20, s * 0.82, s * 0.80, s * 0.18, { color, width: w, jitter: 0.4, taper: 0.9, double: false });
  pen.line(s * 0.80, s * 0.82, s * 0.20, s * 0.18, { color, width: w, jitter: 0.4, taper: 0.9, double: false });
  // Crossguards near each lower hilt (perpendicular short ticks).
  pen.line(s * 0.14, s * 0.72, s * 0.30, s * 0.80, { color, width: w * 0.85, jitter: 0.3, taper: 0.8, double: false });
  pen.line(s * 0.70, s * 0.80, s * 0.86, s * 0.72, { color, width: w * 0.85, jitter: 0.3, taper: 0.8, double: false });
}

/** Replay — a ~300° circular arrow (refresh / watch again). */
export function drawReplay(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x73a1);
  const w = Math.max(1.5, s * 0.05);
  const cx = s / 2, cy = s / 2, r = s * 0.28;
  const start = -Math.PI * 0.35, end = Math.PI * 1.5;
  const N = 16;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const a = start + (end - start) * (i / N);
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  pen.stroke(pts, { color, width: w, jitter: 0.4, taper: 0.92, double: false });
  // Arrowhead at the open end (tangent to the arc).
  const head = pts[pts.length - 1]!;
  const ta = end + Math.PI / 2; // tangent direction
  const hl = s * 0.13;
  pen.line(head.x, head.y, head.x + Math.cos(ta - 0.5) * hl, head.y + Math.sin(ta - 0.5) * hl,
    { color, width: w * 0.9, jitter: 0.3, taper: 0.7, double: false });
  pen.line(head.x, head.y, head.x + Math.cos(ta + 0.6) * hl, head.y + Math.sin(ta + 0.6) * hl,
    { color, width: w * 0.9, jitter: 0.3, taper: 0.7, double: false });
}

/** Share — an up-arrow rising out of an open tray (export). */
export function drawShare(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x4f8b);
  const w = Math.max(1.5, s * 0.05);
  // Open-top tray.
  pen.stroke([
    { x: s * 0.28, y: s * 0.50 }, { x: s * 0.28, y: s * 0.82 },
    { x: s * 0.72, y: s * 0.82 }, { x: s * 0.72, y: s * 0.50 },
  ], { color, width: w, jitter: 0.35, taper: 0.9, double: false });
  // Arrow shaft + head pointing up.
  pen.line(s * 0.5, s * 0.66, s * 0.5, s * 0.20, { color, width: w, jitter: 0.3, taper: 0.88, double: false });
  pen.stroke([
    { x: s * 0.36, y: s * 0.34 }, { x: s * 0.5, y: s * 0.18 }, { x: s * 0.64, y: s * 0.34 },
  ], { color, width: w * 0.9, jitter: 0.3, taper: 0.85, double: false });
}

/** Home (return to lobby) — a little house: triangular roof + square body + door. */
export function drawHome(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x682d);
  const w = Math.max(1.5, s * 0.05);
  // Roof.
  pen.stroke([
    { x: s * 0.16, y: s * 0.50 }, { x: s * 0.5, y: s * 0.22 }, { x: s * 0.84, y: s * 0.50 },
  ], { color, width: w, jitter: 0.4, taper: 0.9, double: false });
  // Body.
  pen.stroke([
    { x: s * 0.28, y: s * 0.46 }, { x: s * 0.28, y: s * 0.80 },
    { x: s * 0.72, y: s * 0.80 }, { x: s * 0.72, y: s * 0.46 },
  ], { color, width: w, jitter: 0.35, taper: 0.9, double: false });
  // Door.
  pen.stroke([
    { x: s * 0.44, y: s * 0.80 }, { x: s * 0.44, y: s * 0.62 },
    { x: s * 0.56, y: s * 0.62 }, { x: s * 0.56, y: s * 0.80 },
  ], { color, width: w * 0.8, jitter: 0.3, taper: 0.85, double: false });
}

/** Tag (shop) — a price tag pointing right: five-sided body with a punched hole. */
export function drawTag(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x7a61);
  const w = Math.max(1.4, s * 0.05);
  pen.stroke([
    { x: s * 0.22, y: s * 0.30 }, { x: s * 0.58, y: s * 0.30 },
    { x: s * 0.80, y: s * 0.50 }, { x: s * 0.58, y: s * 0.70 },
    { x: s * 0.22, y: s * 0.70 }, { x: s * 0.22, y: s * 0.30 },
  ], { color, width: w, jitter: 0.5, taper: 0.95, double: false });
  // Punched hole near the point.
  pen.circle(s * 0.55, s * 0.44, s * 0.035, { color, width: w * 0.7, jitter: 0.25, taper: 0.9, double: false });
}

/** Capsule (gacha) — a toy-machine ball: circle split by a seam, with a shine tick. */
export function drawCapsule(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x7ca9);
  const w = Math.max(1.4, s * 0.05);
  const cx = s / 2, cy = s * 0.52, r = s * 0.30;
  pen.circle(cx, cy, r, { color, width: w, jitter: 0.5, taper: 0.95, double: false });
  // Horizontal seam across the middle (the ball's split line).
  pen.line(cx - r, cy, cx + r, cy, { color, width: w * 0.8, jitter: 0.35, taper: 0.9, double: false });
  // Short shine tick in the upper-left.
  pen.line(cx - r * 0.5, cy - r * 0.5, cx - r * 0.2, cy - r * 0.62,
    { color, width: w * 0.7, jitter: 0.2, taper: 0.6, double: false, alpha: 0.8 });
}

/** Cards (roster) — two overlapping cards, the front ruled with a couple of lines. */
export function drawCards(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x7cd3);
  const w = Math.max(1.4, s * 0.045);
  // Back card, shifted up-right (drawn first → behind).
  pen.stroke([
    { x: s * 0.42, y: s * 0.24 }, { x: s * 0.74, y: s * 0.24 },
    { x: s * 0.74, y: s * 0.66 }, { x: s * 0.42, y: s * 0.66 }, { x: s * 0.42, y: s * 0.24 },
  ], { color, width: w * 0.85, jitter: 0.4, taper: 0.9, double: false, alpha: 0.75 });
  // Front card.
  pen.stroke([
    { x: s * 0.26, y: s * 0.34 }, { x: s * 0.58, y: s * 0.34 },
    { x: s * 0.58, y: s * 0.78 }, { x: s * 0.26, y: s * 0.78 }, { x: s * 0.26, y: s * 0.34 },
  ], { color, width: w, jitter: 0.45, taper: 0.92, double: false });
  // Two faint ruled lines on the front card.
  const lw = Math.max(1, s * 0.022);
  for (let i = 0; i < 2; i++) {
    const ly = s * 0.50 + i * s * 0.12;
    pen.line(s * 0.31, ly, s * 0.53, ly, { color, width: lw, jitter: 0.25, taper: 0.7, double: false, alpha: 0.7 });
  }
}

/** Star (rarity pip / limited-pool marker) — a filled five-point star with a thin ink rim. */
export function drawStar(g: PIXI.Graphics, s: number, color: number): void {
  const cx = s / 2, cy = s * 0.52, rO = s * 0.44, rI = s * 0.18;
  const flat: number[] = [];
  const loop: { x: number; y: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? rO : rI;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    flat.push(x, y);
    loop.push({ x, y });
  }
  g.beginFill(color, 1);
  g.lineStyle(0);
  g.drawPolygon(flat);
  g.endFill();
  // Thin hand-drawn rim to firm up the edges at small sizes.
  loop.push(loop[0]!);
  const pen = new SketchPen(g, 0x57a2);
  pen.stroke(loop, { color, width: Math.max(1, s * 0.03), jitter: 0.25, taper: 0.95, double: false });
}

/** Lock (locked badge) — a padlock: arched shackle over a body with a keyhole. */
export function drawLock(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x10c4);
  const w = Math.max(1.3, s * 0.05);
  const o = { color, width: w, jitter: 0.35, taper: 0.92, double: false };
  // Shackle — upper semicircle arching above the body.
  const cx = s * 0.5, scy = s * 0.47, r = s * 0.15;
  const arc: { x: number; y: number }[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI + (Math.PI * i) / 12;
    arc.push({ x: cx + r * Math.cos(a), y: scy + r * Math.sin(a) });
  }
  pen.stroke(arc, { ...o, width: w * 0.85 });
  // Body — a rounded box.
  pen.stroke([
    { x: s * 0.28, y: s * 0.47 }, { x: s * 0.72, y: s * 0.47 },
    { x: s * 0.72, y: s * 0.80 }, { x: s * 0.28, y: s * 0.80 }, { x: s * 0.28, y: s * 0.47 },
  ], o);
  // Keyhole — a small ring with a short slot.
  pen.circle(cx, s * 0.60, s * 0.045, { ...o, width: w * 0.75 });
  pen.line(cx, s * 0.62, cx, s * 0.71, { ...o, width: w * 0.75 });
}

/** Medal (leaderboard rank) — two ribbon strips descending to a double-ringed disc. */
export function drawMedal(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x3ed1);
  const w = Math.max(1.3, s * 0.05);
  const o = { color, width: w, jitter: 0.35, taper: 0.9, double: false };
  // Ribbons from the top down to the disc.
  pen.line(s * 0.40, s * 0.12, s * 0.46, s * 0.48, o);
  pen.line(s * 0.60, s * 0.12, s * 0.54, s * 0.48, o);
  // Disc + inner ring.
  const cx = s * 0.5, cy = s * 0.64, r = s * 0.22;
  pen.circle(cx, cy, r, o);
  pen.circle(cx, cy, r * 0.58, { ...o, width: w * 0.7 });
}

/** Zoom (map zoom cycle) — a magnifier: a lens ring in the upper-left with a stout diagonal handle. */
export function drawZoom(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x2007);
  const w = Math.max(1.4, s * 0.06);
  const cx = s * 0.44, cy = s * 0.42, r = s * 0.24;
  pen.circle(cx, cy, r, { color, width: w, jitter: 0.4, taper: 0.95, double: false });
  // Handle from the lower-right of the lens outward to the corner.
  const hx = cx + r * Math.SQRT1_2, hy = cy + r * Math.SQRT1_2;
  pen.line(hx, hy, s * 0.80, s * 0.80, { color, width: w * 1.15, jitter: 0.3, taper: 0.85, double: false });
}

/** Gift (mail attachment) — a wrapped present: box + lid over the rim, a centre ribbon and a two-loop bow. */
export function drawGift(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x91f7);
  const w = Math.max(1.3, s * 0.05);
  const o = { color, width: w, jitter: 0.4, taper: 0.92, double: false };
  const lx = s * 0.26, rx = s * 0.74, top = s * 0.44, bot = s * 0.80;
  // Box body.
  pen.stroke([{ x: lx, y: top }, { x: lx, y: bot }, { x: rx, y: bot }, { x: rx, y: top }, { x: lx, y: top }], o);
  // Lid — a slightly wider band across the top of the body.
  const llx = s * 0.22, lrx = s * 0.78, lt = s * 0.32;
  pen.stroke([{ x: llx, y: lt }, { x: llx, y: top }, { x: lrx, y: top }, { x: lrx, y: lt }, { x: llx, y: lt }], o);
  // Centre ribbon down the box.
  pen.line(s * 0.50, lt, s * 0.50, bot, { ...o, width: w * 0.85 });
  // Two-loop bow above the lid.
  pen.stroke([{ x: s * 0.50, y: lt }, { x: s * 0.36, y: s * 0.20 }, { x: s * 0.50, y: s * 0.30 }], { ...o, width: w * 0.8 });
  pen.stroke([{ x: s * 0.50, y: lt }, { x: s * 0.64, y: s * 0.20 }, { x: s * 0.50, y: s * 0.30 }], { ...o, width: w * 0.8 });
}

/** Close (✕) — two crossed ink strokes. */
export function drawClose(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0xc105);
  const w = Math.max(1.5, s * 0.10);
  const o = { color, width: w, jitter: 0.4, taper: 0.85, double: false };
  pen.line(s * 0.28, s * 0.28, s * 0.72, s * 0.72, o);
  pen.line(s * 0.72, s * 0.28, s * 0.28, s * 0.72, o);
}

/** Check (✓) — a single two-segment tick. */
export function drawCheck(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0xc4ec);
  const w = Math.max(1.5, s * 0.11);
  pen.stroke([
    { x: s * 0.22, y: s * 0.52 }, { x: s * 0.42, y: s * 0.70 }, { x: s * 0.78, y: s * 0.26 },
  ], { color, width: w, jitter: 0.35, taper: 0.85, double: false });
}

/** Play (▶) — a filled right-pointing triangle with a thin ink rim. */
export function drawPlay(g: PIXI.Graphics, s: number, color: number): void {
  const pts = [{ x: s * 0.32, y: s * 0.22 }, { x: s * 0.78, y: s * 0.50 }, { x: s * 0.32, y: s * 0.78 }];
  g.beginFill(color, 1);
  g.lineStyle(0);
  g.drawPolygon(pts.flatMap((p) => [p.x, p.y]));
  g.endFill();
  const pen = new SketchPen(g, 0x9147);
  pen.stroke([...pts, pts[0]!], { color, width: Math.max(1, s * 0.05), jitter: 0.25, taper: 0.95, double: false });
}
