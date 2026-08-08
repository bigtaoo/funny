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

/**
 * Armor — a riveted shield: flat top, straight sides, tapered point, centre rib + cross band +
 * corner rivets. Body carries a flat alpha fill (plate "weight", same layered-alpha trick as the
 * SLG shop's coin/hourglass tiers — no gradient) plus a filled boss + solid rivets so it reads as
 * a plated shield at nav-icon size instead of a bare outline.
 */
export function drawArmor(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x6a12);
  const w = Math.max(1.4, s * 0.05);
  const cx = s / 2, hw = s * 0.22, top = s * 0.24;
  const outline = [
    cx - hw, top, cx + hw, top,
    cx + hw, s * 0.50, cx, s * 0.80,
    cx - hw, s * 0.50, cx - hw, top,
  ];
  // Flat plate fill — gives the shield body "weight" without a gradient.
  g.beginFill(color, 0.16); g.lineStyle(0); g.drawPolygon(outline); g.endFill();
  pen.stroke([
    { x: cx - hw, y: top }, { x: cx + hw, y: top },
    { x: cx + hw, y: s * 0.50 }, { x: cx, y: s * 0.80 },
    { x: cx - hw, y: s * 0.50 }, { x: cx - hw, y: top },
  ], { color, width: w, jitter: 0.45, taper: 0.92, double: false });
  pen.line(cx, top + s * 0.04, cx, s * 0.70, { color, width: w * 0.8, jitter: 0.3, taper: 0.9, double: false, alpha: 0.85 });
  // Cross band — reads as a riveted plate rather than a bare outline.
  pen.line(cx - hw * 0.75, top + s * 0.16, cx + hw * 0.75, top + s * 0.16,
    { color, width: w * 0.75, jitter: 0.4, taper: 0.85, double: false, alpha: 0.85 });
  // Faint inner rim on the upper-left facet (emboss).
  pen.stroke([
    { x: cx - hw * 0.7, y: top + s * 0.05 }, { x: cx + hw * 0.7, y: top + s * 0.05 }, { x: cx + hw * 0.7, y: s * 0.46 },
  ], { color, width: w * 0.55, jitter: 0.35, taper: 0.85, double: false, alpha: 0.55 });
  // Centre boss — a small filled disc where the band crosses the rib, reads as a raised stud.
  g.beginFill(color, 0.7); g.lineStyle(0); g.drawCircle(cx, top + s * 0.16, Math.max(1.4, s * 0.028)); g.endFill();
  // Corner rivets — solid dots (was hollow rings), more legible at icon size.
  g.beginFill(color, 0.9); g.lineStyle(0);
  g.drawCircle(cx - hw * 0.62, top + s * 0.06, Math.max(1, s * 0.022));
  g.drawCircle(cx + hw * 0.62, top + s * 0.06, Math.max(1, s * 0.022));
  g.endFill();
}

/**
 * Armor, reinforced — `drawArmor` plus a second lower band and a pair of side rivets, for the
 * longer shop protection tier: a heavier-plated read, not just the same shield + a text label.
 */
export function drawArmorHeavy(g: PIXI.Graphics, s: number, color: number): void {
  drawArmor(g, s, color);
  const pen = new SketchPen(g, 0x6a13);
  const w = Math.max(1.4, s * 0.05);
  const cx = s / 2, hw = s * 0.22;
  // Second band lower down the plate.
  pen.line(cx - hw * 0.55, s * 0.46, cx + hw * 0.55, s * 0.46,
    { color, width: w * 0.7, jitter: 0.4, taper: 0.85, double: false, alpha: 0.8 });
  // Side rivets flanking the centre rib, below the top pair — solid dots, matches drawArmor's.
  g.beginFill(color, 0.9); g.lineStyle(0);
  g.drawCircle(cx - hw * 0.85, s * 0.40, Math.max(1, s * 0.022));
  g.drawCircle(cx + hw * 0.85, s * 0.40, Math.max(1, s * 0.022));
  g.endFill();
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

/**
 * Brush (skin / appearance) — a paintbrush at a diagonal: filled wood handle, a solid ferrule
 * band, and bristles that visibly FLARE out past the ferrule into a fanned tip (the wedge must
 * read wider than the handle, or it reads as a pencil point instead of a brush) — plus a couple
 * of individual bristle-strand lines for texture and a dabbed paint blob at the point. Same
 * layered flat-fill trick as `drawArmor`/the SLG shop icons — no gradient, just more filled
 * shapes than the bare-outline original so it reads as a "loaded brush" at nav-icon size.
 */
export function drawBrush(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x6b89);
  const w = Math.max(1.4, s * 0.05);
  const top = { x: s * 0.76, y: s * 0.20 }, neck = { x: s * 0.46, y: s * 0.50 }, tip = { x: s * 0.24, y: s * 0.76 };
  const dx = neck.x - top.x, dy = neck.y - top.y, len = Math.hypot(dx, dy) || 1;
  const hpx = (-dy / len) * s * 0.045, hpy = (dx / len) * s * 0.045; // handle half-width, perpendicular
  // Filled wood handle — a thin capsule from the butt end to the ferrule.
  g.beginFill(color, 0.55); g.lineStyle(0);
  g.drawPolygon([
    top.x + hpx, top.y + hpy, neck.x + hpx, neck.y + hpy,
    neck.x - hpx, neck.y - hpy, top.x - hpx, top.y - hpy,
  ]);
  g.endFill();
  pen.line(top.x, top.y, neck.x, neck.y, { color, width: w, jitter: 0.4, taper: 0.85, double: false }); // handle rim
  const fpx = (-dy / len) * s * 0.06, fpy = (dx / len) * s * 0.06; // ferrule half-width (base of the flare)
  // Ferrule — a solid metal band, the neck the bristles flare out from.
  g.beginFill(color, 0.8); g.lineStyle(0);
  g.drawPolygon([
    neck.x + hpx, neck.y + hpy, neck.x + fpx, neck.y + fpy,
    neck.x - fpx, neck.y - fpy, neck.x - hpx, neck.y - hpy,
  ]);
  g.endFill();
  // Bristle fan — the tip half-width is ~3x the ferrule's, so the silhouette visibly widens past
  // the neck instead of tapering to a point (the "pencil" failure mode of a narrower wedge).
  const tpx = (-dy / len) * s * 0.16, tpy = (dx / len) * s * 0.16;
  const tipL = { x: tip.x + tpx, y: tip.y + tpy }, tipR = { x: tip.x - tpx, y: tip.y - tpy };
  g.beginFill(color, 0.45); g.lineStyle(0);
  g.drawPolygon([neck.x + fpx, neck.y + fpy, tipL.x, tipL.y, tipR.x, tipR.y, neck.x - fpx, neck.y - fpy]);
  g.endFill();
  pen.stroke([
    { x: neck.x + fpx, y: neck.y + fpy }, { x: tipL.x, y: tipL.y },
  ], { color, width: w * 0.8, jitter: 0.4, taper: 0.85, double: false }); // fan rim, left edge
  pen.stroke([
    { x: neck.x - fpx, y: neck.y - fpy }, { x: tipR.x, y: tipR.y },
  ], { color, width: w * 0.8, jitter: 0.4, taper: 0.85, double: false }); // fan rim, right edge
  pen.line(tipL.x, tipL.y, tipR.x, tipR.y, { color, width: w * 0.7, jitter: 0.4, taper: 0.9, double: false }); // tip edge
  // A couple of individual bristle-strand ticks inside the fan, for texture.
  for (const t of [0.35, 0.65]) {
    const bx = tipR.x + (tipL.x - tipR.x) * t, by = tipR.y + (tipL.y - tipR.y) * t;
    pen.line(neck.x, neck.y, bx, by, { color, width: w * 0.35, jitter: 0.3, taper: 0.5, double: false, alpha: 0.5 });
  }
  // A dabbed blob of paint at the tip, plus a short trailing stroke off to the side.
  g.beginFill(color, 0.85); g.lineStyle(0);
  g.drawCircle(tip.x, tip.y + s * 0.02, Math.max(1.4, s * 0.03));
  g.endFill();
  pen.line(tip.x, tip.y + s * 0.05, tip.x + s * 0.13, tip.y + s * 0.03,
    { color, width: w * 0.6, jitter: 0.5, taper: 0.5, double: false, alpha: 0.7 }); // paint stroke
}
