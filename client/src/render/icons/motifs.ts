/**
 * motifs.ts — lobby / hero doodles: book, globe, trophy, castle, crossed pencils.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from '../sketch';
import { battlement } from './primitives';

/** Open book — splayed pages over a centre spine, with a couple of text lines. */
export function drawBook(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x600d);
  const w = Math.max(1.5, s * 0.05);
  const cx = s / 2;
  const outX = s * 0.14;
  const outerTop = s * 0.30;     // pages rise to the outer top corners
  const innerTop = s * 0.35;     // spine dips lower at the centre
  const botY = s * 0.70;
  const spineBot = botY + s * 0.02;

  // Left + right page outlines (inner top → outer top → outer bottom → spine base).
  pen.stroke([
    { x: cx, y: innerTop }, { x: outX, y: outerTop },
    { x: outX, y: botY }, { x: cx, y: spineBot },
  ], { color, width: w, jitter: 0.7, taper: 0.9, double: false });
  pen.stroke([
    { x: cx, y: innerTop }, { x: s - outX, y: outerTop },
    { x: s - outX, y: botY }, { x: cx, y: spineBot },
  ], { color, width: w, jitter: 0.7, taper: 0.9, double: false });
  // Spine.
  pen.line(cx, innerTop, cx, spineBot, { color, width: w * 0.85, jitter: 0.4, taper: 0.9, double: false });

  // Faint text lines on each page.
  const lw = Math.max(1, s * 0.022);
  for (let i = 0; i < 2; i++) {
    const ly = innerTop + s * 0.08 + i * s * 0.11;
    pen.line(outX + s * 0.04, ly + s * 0.01, cx - s * 0.04, ly,
      { color, width: lw, jitter: 0.3, taper: 0.7, double: false, alpha: 0.7 });
    pen.line(cx + s * 0.04, ly, s - outX - s * 0.04, ly + s * 0.01,
      { color, width: lw, jitter: 0.3, taper: 0.7, double: false, alpha: 0.7 });
  }
}

/** Globe — circle outline + vertical meridian ellipse + bowed equator + a latitude. */
export function drawGlobe(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x61b);
  const w = Math.max(1.5, s * 0.045);
  const cx = s / 2, cy = s / 2, r = s * 0.32;

  pen.circle(cx, cy, r, { color, width: w, jitter: 0.6, taper: 0.95, double: false });

  // Equator (slightly bowed horizontal).
  pen.stroke([
    { x: cx - r, y: cy }, { x: cx, y: cy + s * 0.02 }, { x: cx + r, y: cy },
  ], { color, width: w * 0.8, jitter: 0.35, taper: 0.9, double: false });
  // A latitude above the equator.
  pen.stroke([
    { x: cx - r * 0.86, y: cy - r * 0.5 }, { x: cx, y: cy - r * 0.42 }, { x: cx + r * 0.86, y: cy - r * 0.5 },
  ], { color, width: w * 0.7, jitter: 0.3, taper: 0.9, double: false, alpha: 0.85 });
  // Meridian — a vertical ellipse traced as a closed wobbled loop.
  const rx = r * 0.42;
  const mer = [];
  for (let i = 0; i <= 20; i++) {
    const a = (Math.PI * 2 * i) / 20;
    mer.push({ x: cx + rx * Math.sin(a), y: cy - r * Math.cos(a) });
  }
  pen.stroke(mer, { color, width: w * 0.7, jitter: 0.3, taper: 0.95, double: false });
}

/** Trophy — bowl + two side handles + stem + pedestal base. */
export function drawTrophy(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x60c);
  const w = Math.max(1.5, s * 0.05);
  const cx = s / 2;
  const cupTop = s * 0.26, cupBot = s * 0.52;
  const halfTop = s * 0.20, halfBot = s * 0.11;

  // Bowl sides + rim.
  pen.stroke([
    { x: cx - halfTop, y: cupTop }, { x: cx - halfBot, y: cupBot },
    { x: cx + halfBot, y: cupBot }, { x: cx + halfTop, y: cupTop },
  ], { color, width: w, jitter: 0.5, taper: 0.95, double: false });
  pen.line(cx - halfTop, cupTop, cx + halfTop, cupTop, { color, width: w, jitter: 0.4, taper: 0.9, double: false });

  // Side handles — half-ellipses bulging outward from the rim.
  const handle = (dir: number) => {
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / 8;
      pts.push({
        x: cx + dir * (halfTop + Math.cos(a) * s * 0.1),
        y: cupTop + s * 0.04 + (Math.sin(a) + 1) * s * 0.06,
      });
    }
    pen.stroke(pts, { color, width: w * 0.8, jitter: 0.3, taper: 0.9, double: false });
  };
  handle(1);
  handle(-1);

  // Stem + pedestal base.
  pen.line(cx, cupBot, cx, s * 0.66, { color, width: w, jitter: 0.3, taper: 0.9, double: false });
  pen.stroke([
    { x: cx - s * 0.07, y: s * 0.66 }, { x: cx - s * 0.14, y: s * 0.74 },
    { x: cx + s * 0.14, y: s * 0.74 }, { x: cx + s * 0.07, y: s * 0.66 },
  ], { color, width: w, jitter: 0.4, taper: 0.9, double: false });
  pen.line(cx - s * 0.14, s * 0.74, cx + s * 0.14, s * 0.74, { color, width: w, jitter: 0.4, taper: 0.9, double: false });
}

/**
 * Castle motif (world-map pillar): two crenellated towers flanking a central
 * battlemented wall with an arched gate and a small pennant. Drawn large + faint
 * as the card's hero doodle (art-direction §6: hand-drawn motifs over photos).
 */
export function drawCastle(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x6ca5);
  const w = Math.max(1.5, s * 0.04);
  const opt = { color, width: w, jitter: 0.6, taper: 0.92, double: false };

  const baseY = s * 0.76, wallTop = s * 0.50, towerTop = s * 0.30;
  const Lx0 = s * 0.13, Lx1 = s * 0.30;
  const Rx0 = s * 0.70, Rx1 = s * 0.87;
  const Wx0 = s * 0.30, Wx1 = s * 0.70;

  pen.stroke([{ x: Lx0, y: baseY }, { x: Lx0, y: towerTop }, { x: Lx1, y: towerTop }, { x: Lx1, y: baseY }], opt);
  pen.stroke([{ x: Rx0, y: baseY }, { x: Rx0, y: towerTop }, { x: Rx1, y: towerTop }, { x: Rx1, y: baseY }], opt);
  pen.stroke([{ x: Wx0, y: baseY }, { x: Wx0, y: wallTop }, { x: Wx1, y: wallTop }, { x: Wx1, y: baseY }], opt);
  pen.line(Lx0, baseY, Rx1, baseY, opt);

  battlement(pen, Lx0, Lx1, towerTop, s * 0.07, 3, opt);
  battlement(pen, Rx0, Rx1, towerTop, s * 0.07, 3, opt);
  battlement(pen, Wx0, Wx1, wallTop, s * 0.06, 5, opt);

  // Arched gate in the central wall.
  pen.stroke([
    { x: s * 0.43, y: baseY }, { x: s * 0.43, y: s * 0.60 },
    { x: s * 0.50, y: s * 0.555 }, { x: s * 0.57, y: s * 0.60 }, { x: s * 0.57, y: baseY },
  ], { ...opt, width: w * 0.8 });

  // Pennant on the left tower.
  const fx = (Lx0 + Lx1) / 2;
  pen.line(fx, towerTop, fx, towerTop - s * 0.14, { ...opt, width: w * 0.7 });
  pen.stroke([
    { x: fx, y: towerTop - s * 0.14 }, { x: fx + s * 0.10, y: towerTop - s * 0.11 }, { x: fx, y: towerTop - s * 0.08 },
  ], { ...opt, width: w * 0.7 });
}

/**
 * Crossed-pencils motif (matchmaking hero): two stationery pencils in an X — tips
 * down, ferrules + erasers up. Echoes the "three stationery pens" art language;
 * drawn large + faint behind the hero label.
 */
export function drawPencils(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x6e17);
  const w = Math.max(1.5, s * 0.035);
  const hw = s * 0.05;
  const o = { color, width: w, jitter: 0.5, taper: 0.9, double: false };

  const pencil = (ax: number, ay: number, bx: number, by: number): void => {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, px = -uy * hw, py = ux * hw;
    const tipLen = len * 0.16;
    const sx = ax + ux * tipLen, sy = ay + uy * tipLen;       // tip → body shoulder
    pen.stroke([{ x: ax, y: ay }, { x: sx + px, y: sy + py }], o);
    pen.stroke([{ x: ax, y: ay }, { x: sx - px, y: sy - py }], o);
    pen.line(sx + px, sy + py, sx - px, sy - py, o);          // shoulder
    pen.line(sx + px, sy + py, bx + px, by + py, o);          // body sides
    pen.line(sx - px, sy - py, bx - px, by - py, o);
    pen.line(bx + px, by + py, bx - px, by - py, o);          // eraser end cap
    const fx = bx - ux * len * 0.10, fy = by - uy * len * 0.10;
    pen.line(fx + px, fy + py, fx - px, fy - py, { ...o, width: w * 0.8 }); // ferrule
  };

  pencil(s * 0.16, s * 0.82, s * 0.84, s * 0.20);
  pencil(s * 0.84, s * 0.82, s * 0.16, s * 0.20);
}
