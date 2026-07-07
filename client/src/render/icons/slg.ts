/**
 * slg.ts — SLG march-kind glyphs (scope / flag) + city building glyphs
 * (desk / cabinet / hammer).
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from '../sketch';

/** Scope (scout) — a slanted telescope tube with a narrow eyepiece and a wider objective rim. */
export function drawScope(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x5e21);
  const w = Math.max(1.4, s * 0.05);
  const near = { x: s * 0.26, y: s * 0.74 }, far = { x: s * 0.72, y: s * 0.30 };
  pen.line(near.x, near.y, far.x, far.y, { color, width: w, jitter: 0.4, taper: 0.9, double: false }); // tube
  const dx = far.x - near.x, dy = far.y - near.y, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  pen.line(near.x + nx * s * 0.05, near.y + ny * s * 0.05, near.x - nx * s * 0.05, near.y - ny * s * 0.05,
    { color, width: w * 0.85, jitter: 0.3, taper: 0.8, double: false }); // eyepiece
  pen.line(far.x + nx * s * 0.10, far.y + ny * s * 0.10, far.x - nx * s * 0.10, far.y - ny * s * 0.10,
    { color, width: w * 0.9, jitter: 0.3, taper: 0.8, double: false }); // objective rim
}

/** Flag (occupy) — a vertical pole with a triangular pennant near the top. */
export function drawFlag(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x4c7d);
  const w = Math.max(1.4, s * 0.05);
  const poleX = s * 0.34;
  pen.line(poleX, s * 0.16, poleX, s * 0.84, { color, width: w, jitter: 0.35, taper: 0.9, double: false }); // pole
  pen.stroke([
    { x: poleX, y: s * 0.18 }, { x: s * 0.74, y: s * 0.30 }, { x: poleX, y: s * 0.46 },
  ], { color, width: w * 0.9, jitter: 0.4, taper: 0.9, double: false }); // pennant
}

/** Desk (city HQ) — a tabletop on a left leg + a right drawer pedestal with a knob. */
export function drawDesk(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x0e5c);
  const w = Math.max(1.4, s * 0.045);
  const o = { color, width: w, jitter: 0.4, taper: 0.9, double: false };
  // Tabletop.
  pen.stroke([
    { x: s * 0.14, y: s * 0.40 }, { x: s * 0.86, y: s * 0.40 },
  ], o);
  // Left leg.
  pen.line(s * 0.22, s * 0.40, s * 0.22, s * 0.80, o);
  // Right drawer pedestal (box) with one drawer divider.
  pen.stroke([
    { x: s * 0.54, y: s * 0.40 }, { x: s * 0.54, y: s * 0.80 },
    { x: s * 0.80, y: s * 0.80 }, { x: s * 0.80, y: s * 0.40 },
  ], o);
  pen.line(s * 0.54, s * 0.56, s * 0.80, s * 0.56, { ...o, width: w * 0.8 });
  // Drawer knob.
  pen.circle(s * 0.67, s * 0.48, s * 0.02, { ...o, width: w * 0.7 });
}

/** Cabinet (city archive/warehouse) — a tall body split into three drawers, each with a handle. */
export function drawCabinet(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x0ab7);
  const w = Math.max(1.4, s * 0.045);
  const o = { color, width: w, jitter: 0.4, taper: 0.92, double: false };
  const lx = s * 0.30, rx = s * 0.70, top = s * 0.20, bot = s * 0.82;
  pen.stroke([
    { x: lx, y: top }, { x: rx, y: top }, { x: rx, y: bot }, { x: lx, y: bot }, { x: lx, y: top },
  ], o);
  // Two dividers → three drawers; a short centred handle line in each.
  const rows = [top, s * 0.41, s * 0.62, bot];
  for (let i = 1; i < 3; i++) {
    pen.line(lx, rows[i]!, rx, rows[i]!, { ...o, width: w * 0.8 });
  }
  for (let i = 0; i < 3; i++) {
    const my = (rows[i]! + rows[i + 1]!) / 2;
    pen.line(s * 0.44, my, s * 0.56, my, { ...o, width: w * 0.7 });
  }
}

/** Hammer (build-queue badge) — a diagonal handle capped by a rectangular head. */
export function drawHammer(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x4a33);
  const w = Math.max(1.4, s * 0.06);
  const grip = { x: s * 0.34, y: s * 0.80 }, neck = { x: s * 0.60, y: s * 0.42 };
  // Handle.
  pen.line(grip.x, grip.y, neck.x, neck.y, { color, width: w, jitter: 0.35, taper: 0.85, double: false });
  // Head — a short thick bar across the top of the handle, perpendicular to it.
  const dx = neck.x - grip.x, dy = neck.y - grip.y, len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * s * 0.16, py = (dx / len) * s * 0.16;
  pen.line(neck.x + px, neck.y + py, neck.x - px, neck.y - py,
    { color, width: w * 1.5, jitter: 0.3, taper: 0.9, double: false });
}
