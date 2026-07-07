/**
 * equipment.ts — equipment-page materials (scrap / lead / binding), stat icons
 * (attack / HP / armor / move-speed / attack-speed) + the collection skin brush.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from '../sketch';

/** Scrap — a torn notebook offcut: rectangle with a ragged bottom edge + ruled lines. */
export function drawScrap(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x5c4a);
  const w = Math.max(1.4, s * 0.045);
  const lx = s * 0.26, rx = s * 0.74, top = s * 0.24;
  // Outline: top edge → right side → ragged bottom (zigzag) → left side → close.
  pen.stroke([
    { x: lx, y: top }, { x: rx, y: top }, { x: rx, y: s * 0.60 },
    { x: rx - s * 0.12, y: s * 0.68 }, { x: rx - s * 0.24, y: s * 0.60 },
    { x: lx + s * 0.12, y: s * 0.70 }, { x: lx, y: s * 0.62 }, { x: lx, y: top },
  ], { color, width: w, jitter: 0.6, taper: 0.95, double: false });
  // Two faint ruled lines.
  const lw = Math.max(1, s * 0.024);
  for (let i = 0; i < 2; i++) {
    const ly = top + s * 0.11 + i * s * 0.12;
    pen.line(lx + s * 0.05, ly, rx - s * 0.05, ly,
      { color, width: lw, jitter: 0.25, taper: 0.7, double: false, alpha: 0.65 });
  }
}

/** Lead — a sharpened graphite stick: a short tapered diagonal rod with a cut base. */
export function drawLead(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x1ead);
  const tip = { x: s * 0.72, y: s * 0.26 };
  const base = { x: s * 0.30, y: s * 0.74 };
  // Tapered bar: thick at the base, sharpening to the tip.
  pen.stroke([base, tip], { color, width: Math.max(2, s * 0.11), jitter: 0.4, taper: 0.18, double: false });
  // Flat cut at the base (perpendicular cap).
  const dx = tip.x - base.x, dy = tip.y - base.y, len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * s * 0.07, py = (dx / len) * s * 0.07;
  pen.line(base.x + px, base.y + py, base.x - px, base.y - py,
    { color, width: Math.max(1.2, s * 0.035), jitter: 0.3, taper: 0.8, double: false });
}

/** Binding — spiral-notebook coil: three slanted rings threaded on a spine. */
export function drawBinding(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x0b1d);
  const w = Math.max(1.3, s * 0.04);
  const cx = s * 0.5, rx = s * 0.16, ry = s * 0.075;
  for (let r = 0; r < 3; r++) {
    const cy = s * 0.30 + r * s * 0.20;
    const loop = [];
    for (let i = 0; i <= 16; i++) {
      const a = (Math.PI * 2 * i) / 16;
      // Slant each ring slightly so the coil reads as 3-D.
      loop.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) + Math.cos(a) * s * 0.03 });
    }
    pen.stroke(loop, { color, width: w, jitter: 0.3, taper: 0.95, double: false });
  }
}

/** Attack — an upright blade: lozenge edge, crossguard, hilt. */
export function drawAtk(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x6a7c);
  const w = Math.max(1.4, s * 0.05);
  const cx = s / 2;
  pen.stroke([
    { x: cx, y: s * 0.14 }, { x: cx - s * 0.05, y: s * 0.30 },
    { x: cx - s * 0.04, y: s * 0.56 }, { x: cx + s * 0.04, y: s * 0.56 },
    { x: cx + s * 0.05, y: s * 0.30 }, { x: cx, y: s * 0.14 },
  ], { color, width: w, jitter: 0.4, taper: 0.9, double: false });
  // Crossguard + hilt + pommel.
  pen.line(cx - s * 0.16, s * 0.58, cx + s * 0.16, s * 0.58, { color, width: w, jitter: 0.4, taper: 0.85, double: false });
  pen.line(cx, s * 0.58, cx, s * 0.78, { color, width: w * 0.9, jitter: 0.3, taper: 0.9, double: false });
  pen.line(cx - s * 0.06, s * 0.80, cx + s * 0.06, s * 0.80, { color, width: w, jitter: 0.3, taper: 0.8, double: false });
}

/** Health — a doodled heart (parametric outline, closed). */
export function drawHp(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x6097);
  const w = Math.max(1.4, s * 0.055);
  const cx = s / 2, cy = s * 0.46, k = s * 0.025;
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const tt = (Math.PI * 2 * i) / 24;
    const hx = 16 * Math.pow(Math.sin(tt), 3);
    const hy = 13 * Math.cos(tt) - 5 * Math.cos(2 * tt) - 2 * Math.cos(3 * tt) - Math.cos(4 * tt);
    pts.push({ x: cx + hx * k, y: cy - hy * k });
  }
  pen.stroke(pts, { color, width: w, jitter: 0.5, taper: 0.96, double: false });
}

/** Armor — a shield: flat top, straight sides, tapered point, centre rib. */
export function drawArmor(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x6a12);
  const w = Math.max(1.4, s * 0.05);
  const cx = s / 2, hw = s * 0.22, top = s * 0.24;
  pen.stroke([
    { x: cx - hw, y: top }, { x: cx + hw, y: top },
    { x: cx + hw, y: s * 0.50 }, { x: cx, y: s * 0.80 },
    { x: cx - hw, y: s * 0.50 }, { x: cx - hw, y: top },
  ], { color, width: w, jitter: 0.45, taper: 0.92, double: false });
  pen.line(cx, top + s * 0.04, cx, s * 0.70, { color, width: w * 0.8, jitter: 0.3, taper: 0.9, double: false, alpha: 0.85 });
}

/** Speed — twin forward chevrons (motion lines). */
export function drawSpd(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x65bd);
  const w = Math.max(1.5, s * 0.06);
  for (const ox of [s * 0.34, s * 0.54]) {
    pen.stroke([
      { x: ox, y: s * 0.28 }, { x: ox + s * 0.16, y: s * 0.50 }, { x: ox, y: s * 0.72 },
    ], { color, width: w, jitter: 0.35, taper: 0.9, double: false });
  }
}

/** Attack speed — a lightning bolt (zigzag). */
export function drawAtkspd(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x6a5d);
  const w = Math.max(1.5, s * 0.06);
  pen.stroke([
    { x: s * 0.62, y: s * 0.18 }, { x: s * 0.36, y: s * 0.50 },
    { x: s * 0.52, y: s * 0.50 }, { x: s * 0.36, y: s * 0.82 },
  ], { color, width: w, jitter: 0.35, taper: 0.88, double: false });
}

/** Brush (skin / appearance) — a paintbrush at a diagonal with a ferrule + paint tip. */
export function drawBrush(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x6b89);
  const w = Math.max(1.4, s * 0.05);
  const top = { x: s * 0.76, y: s * 0.20 }, neck = { x: s * 0.46, y: s * 0.50 }, tip = { x: s * 0.28, y: s * 0.72 };
  pen.line(top.x, top.y, neck.x, neck.y, { color, width: w, jitter: 0.4, taper: 0.85, double: false }); // handle
  const dx = neck.x - top.x, dy = neck.y - top.y, len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * s * 0.06, py = (dx / len) * s * 0.06;
  pen.line(neck.x + px, neck.y + py, neck.x - px, neck.y - py, { color, width: w * 0.9, jitter: 0.3, taper: 0.8, double: false }); // ferrule
  pen.stroke([
    { x: neck.x + px, y: neck.y + py }, { x: tip.x, y: tip.y }, { x: neck.x - px, y: neck.y - py },
  ], { color, width: w * 0.9, jitter: 0.45, taper: 0.9, double: false }); // bristles
  pen.line(tip.x - s * 0.04, tip.y + s * 0.06, tip.x + s * 0.10, tip.y + s * 0.04,
    { color, width: w * 0.7, jitter: 0.5, taper: 0.6, double: false, alpha: 0.8 }); // paint stroke
}
