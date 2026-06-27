/**
 * icons.ts — small hand-drawn UI glyphs (book / globe / coin / trophy).
 *
 * Replaces emoji placeholders in the lobby with SketchPen line-art so the icons
 * share the worn-notebook ink language (art-direction: three stationery pens,
 * flat scrawl, no gradients). Each icon is drawn once into an `s × s` box at
 * local origin (0,0) and baked to a GPU texture via `uiCache` (cache key folds
 * in kind + size + colour), so repeated lobby builds cost nothing. Headless
 * tests with no renderer transparently fall back to a live draw.
 *
 * Coordinates are normalised to the box size `s` and content is centred, so a
 * caller can position either the baked Sprite or the live Graphics by its
 * top-left corner the same way.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen, StrokeOpts } from './sketch';
import { getCachedDisplay } from '../ui/widgets/uiCache';

export type IconKind =
  | 'book' | 'globe' | 'coin' | 'trophy' | 'castle' | 'pencils'
  // 装备页材料 (EQUIPMENT_DESIGN)：碎屑 / 铅芯 / 装订线。
  | 'scrap' | 'lead' | 'binding'
  // 装备页词条统计：攻击 / 生命 / 护甲 / 移速 / 攻速。
  | 'atk' | 'hp' | 'armor' | 'spd' | 'atkspd'
  // 养成页皮肤标签：外观笔刷（卡牌/单位用真实 png 立绘，见 cardArt.ts）。
  | 'brush';

/** Open book — splayed pages over a centre spine, with a couple of text lines. */
function drawBook(g: PIXI.Graphics, s: number, color: number): void {
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
function drawGlobe(g: PIXI.Graphics, s: number, color: number): void {
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

/** Coin — two concentric ink rings + a small centre sparkle (the shine). */
function drawCoin(g: PIXI.Graphics, s: number, color: number): void {
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

/** Trophy — bowl + two side handles + stem + pedestal base. */
function drawTrophy(g: PIXI.Graphics, s: number, color: number): void {
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
 * Square-wave crenellation along the top edge `[x0,x1]` at height `yBase`,
 * merlons rising `depth` above it. Used for castle battlements.
 */
function battlement(
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

/**
 * Castle motif (大世界 pillar): two crenellated towers flanking a central
 * battlemented wall with an arched gate and a small pennant. Drawn large + faint
 * as the card's hero doodle (art-direction §6: hand-drawn motifs over photos).
 */
function drawCastle(g: PIXI.Graphics, s: number, color: number): void {
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
 * Crossed-pencils motif (开始匹配 hero): two stationery pencils in an X — tips
 * down, ferrules + erasers up. Echoes the "three stationery pens" art language;
 * drawn large + faint behind the hero label.
 */
function drawPencils(g: PIXI.Graphics, s: number, color: number): void {
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

/** Scrap — a torn notebook offcut: rectangle with a ragged bottom edge + ruled lines. */
function drawScrap(g: PIXI.Graphics, s: number, color: number): void {
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
function drawLead(g: PIXI.Graphics, s: number, color: number): void {
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
function drawBinding(g: PIXI.Graphics, s: number, color: number): void {
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
function drawAtk(g: PIXI.Graphics, s: number, color: number): void {
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
function drawHp(g: PIXI.Graphics, s: number, color: number): void {
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
function drawArmor(g: PIXI.Graphics, s: number, color: number): void {
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
function drawSpd(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x65bd);
  const w = Math.max(1.5, s * 0.06);
  for (const ox of [s * 0.34, s * 0.54]) {
    pen.stroke([
      { x: ox, y: s * 0.28 }, { x: ox + s * 0.16, y: s * 0.50 }, { x: ox, y: s * 0.72 },
    ], { color, width: w, jitter: 0.35, taper: 0.9, double: false });
  }
}

/** Attack speed — a lightning bolt (zigzag). */
function drawAtkspd(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x6a5d);
  const w = Math.max(1.5, s * 0.06);
  pen.stroke([
    { x: s * 0.62, y: s * 0.18 }, { x: s * 0.36, y: s * 0.50 },
    { x: s * 0.52, y: s * 0.50 }, { x: s * 0.36, y: s * 0.82 },
  ], { color, width: w, jitter: 0.35, taper: 0.88, double: false });
}

/** Brush (skin / appearance) — a paintbrush at a diagonal with a ferrule + paint tip. */
function drawBrush(g: PIXI.Graphics, s: number, color: number): void {
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

const DRAW: Record<IconKind, (g: PIXI.Graphics, s: number, color: number) => void> = {
  book:    drawBook,
  globe:   drawGlobe,
  coin:    drawCoin,
  trophy:  drawTrophy,
  castle:  drawCastle,
  pencils: drawPencils,
  scrap:   drawScrap,
  lead:    drawLead,
  binding: drawBinding,
  atk:     drawAtk,
  hp:      drawHp,
  armor:   drawArmor,
  spd:     drawSpd,
  atkspd:  drawAtkspd,
  brush:   drawBrush,
};

/**
 * A baked, reusable hand-drawn icon sized `size × size`, drawn in `color`.
 * Returns a `PIXI.Sprite` of the cached texture (or a live Graphics in headless
 * tests). Position by its top-left corner; the artwork is centred in the box.
 */
export function buildIcon(kind: IconKind, size: number, color: number): PIXI.DisplayObject {
  const s = Math.round(size);
  const key = `icon:${kind}:${s}:${(color >>> 0).toString(16)}`;
  return getCachedDisplay(key, () => {
    const g = new PIXI.Graphics();
    DRAW[kind](g, s, color);
    return g;
  }, s, s);
}
