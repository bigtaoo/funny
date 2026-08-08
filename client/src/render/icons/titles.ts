/**
 * titles.ts — ladder-rank & SLG-season medal glyphs for the title wall (TitlesScene).
 *
 * The 4 permanent titles (founder/veteran/newbie/all_chapters) already have bespoke AI-drawn
 * medal art (render/titleArt.ts, TITLE_DESIGN §"称号墙 4 枚永久称号换 AI 手绘勋章图标"). Every
 * other title — 9 ladder ranks + 2 SLG season titles, id space not closed — fell back to a
 * single undifferentiated `medal` glyph (icons/ui.ts drawMedal) tinted by state, so a bronze
 * player and a king player saw the exact same icon.
 *
 * These glyphs replace that fallback with one distinct, increasingly elaborate silhouette per
 * rank — same "richer tier = more detail" language as the recharge coin ladder
 * (icons/currency.ts) and the SLG shop's protection/speed-up tiers (icons/slg.ts). They stay
 * single-tint on purpose (the whole glyph draws in the caller's `color`, alpha-layered fills for
 * depth) so they keep working with TitlesScene's existing equipped/owned/locked recolouring —
 * no gradients (art-direction §4); "richness" comes from alpha-layered fills + stroke/element
 * count, not hue.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen, StrokeOpts } from '../sketch';

type Pt = { x: number; y: number };

// ── Shared sub-drawings ──────────────────────────────────────────────────────

/** Two ribbon strips from the top of the box down toward the disc; `doubled` adds a faint second pass per side (richer tiers). */
function ribbons(pen: SketchPen, s: number, color: number, w: number, doubled: boolean): void {
  const o: StrokeOpts = { color, width: w, jitter: 0.35, taper: 0.9, double: false };
  pen.line(s * 0.40, s * 0.10, s * 0.46, s * 0.44, o);
  pen.line(s * 0.60, s * 0.10, s * 0.54, s * 0.44, o);
  if (doubled) {
    pen.line(s * 0.365, s * 0.10, s * 0.415, s * 0.44, { ...o, width: w * 0.65, alpha: 0.65 });
    pen.line(s * 0.635, s * 0.10, s * 0.585, s * 0.44, { ...o, width: w * 0.65, alpha: 0.65 });
  }
}

/** Circular disc: flat alpha-fill (material "weight") + ink rim, optional inner ring. */
function discBody(g: PIXI.Graphics, pen: SketchPen, cx: number, cy: number, r: number, color: number, w: number, fillA: number, ring: boolean): void {
  if (fillA > 0) { g.beginFill(color, fillA); g.lineStyle(0); g.drawCircle(cx, cy, r); g.endFill(); }
  const o: StrokeOpts = { color, width: w, jitter: 0.35, taper: 0.9, double: false };
  pen.circle(cx, cy, r, o);
  if (ring) pen.circle(cx, cy, r * 0.6, { ...o, width: w * 0.7 });
}

/** Hexagonal disc (platinum) — same fill/rim/ring language as discBody but a distinct cut-facet silhouette. */
function hexBody(g: PIXI.Graphics, pen: SketchPen, cx: number, cy: number, r: number, color: number, w: number, fillA: number, ring: boolean): void {
  const pts: Pt[] = [];
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  if (fillA > 0) { g.beginFill(color, fillA); g.lineStyle(0); g.drawPolygon(pts.flatMap((p) => [p.x, p.y])); g.endFill(); }
  const o: StrokeOpts = { color, width: w, jitter: 0.3, taper: 0.92, double: false };
  pen.stroke([...pts, pts[0]!], o);
  if (ring) {
    const ip = pts.map((p) => ({ x: cx + (p.x - cx) * 0.6, y: cy + (p.y - cy) * 0.6 }));
    pen.stroke([...ip, ip[0]!], { ...o, width: w * 0.7 });
  }
}

/** Five-point star disc (the "star" ladder rank) — the medal body itself is star-shaped. */
function starBody(g: PIXI.Graphics, pen: SketchPen, cx: number, cy: number, rO: number, color: number, w: number, fillA: number): void {
  const rI = rO * 0.46;
  const flat: number[] = [];
  const loop: Pt[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? rO : rI;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    flat.push(x, y);
    loop.push({ x, y });
  }
  if (fillA > 0) { g.beginFill(color, fillA); g.lineStyle(0); g.drawPolygon(flat); g.endFill(); }
  loop.push(loop[0]!);
  pen.stroke(loop, { color, width: w, jitter: 0.3, taper: 0.9, double: false });
}

/** Shield body (SLG season titles) — distinct silhouette from the hung-medal ladder ranks. */
function shieldBody(g: PIXI.Graphics, pen: SketchPen, cx: number, cy: number, halfW: number, halfH: number, color: number, w: number, fillA: number, ring: boolean): void {
  const pts: Pt[] = [
    { x: cx - halfW, y: cy - halfH },
    { x: cx + halfW, y: cy - halfH },
    { x: cx + halfW, y: cy + halfH * 0.35 },
    { x: cx, y: cy + halfH * 1.25 },
    { x: cx - halfW, y: cy + halfH * 0.35 },
  ];
  if (fillA > 0) { g.beginFill(color, fillA); g.lineStyle(0); g.drawPolygon(pts.flatMap((p) => [p.x, p.y])); g.endFill(); }
  const o: StrokeOpts = { color, width: w, jitter: 0.35, taper: 0.92, double: false };
  pen.stroke([...pts, pts[0]!], o);
  if (ring) {
    const ip = pts.map((p) => ({ x: cx + (p.x - cx) * 0.68, y: cy + (p.y - cy) * 0.68 }));
    pen.stroke([...ip, ip[0]!], { ...o, width: w * 0.65 });
  }
}

/** Radiating cut-gem facet lines from centre toward the rim (platinum/diamond). */
function facets(pen: SketchPen, cx: number, cy: number, r: number, n: number, color: number, w: number): void {
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * ((Math.PI * 2) / n);
    pen.line(cx, cy, cx + Math.cos(a) * r * 0.88, cy + Math.sin(a) * r * 0.88,
      { color, width: w * 0.4, jitter: 0.2, taper: 0.5, double: false, alpha: 0.5 });
  }
}

/** Faint sunburst rays behind the disc (king only — the single most decorated rank). */
function burst(pen: SketchPen, cx: number, cy: number, r: number, color: number, w: number): void {
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * ((Math.PI * 2) / n);
    pen.line(cx + Math.cos(a) * r * 1.2, cy + Math.sin(a) * r * 1.2, cx + Math.cos(a) * r * 1.6, cy + Math.sin(a) * r * 1.6,
      { color, width: w * 0.45, jitter: 0.25, taper: 0.3, double: false, alpha: 0.45 });
  }
}

/** `n` small leaf ticks flanking each side of the disc, fanning from its rim (master and up). */
function laurel(pen: SketchPen, cx: number, cy: number, r: number, n: number, color: number, w: number): void {
  if (n <= 0) return;
  const o: StrokeOpts = { color, width: w * 0.65, jitter: 0.3, taper: 0.85, double: false };
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const a = Math.PI * (0.15 + t * 0.6);
      const bx = cx + side * Math.cos(a) * r * 0.95, by = cy + Math.sin(a) * r * 0.95;
      const tx = cx + side * Math.cos(a) * r * 1.55, ty = cy + Math.sin(a) * r * 1.55;
      pen.line(bx, by, tx, ty, o);
    }
  }
}

/** A small 3-peak crown above the disc; `big` (grandmaster+) makes it taller with a centre jewel. */
function crown(pen: SketchPen, cx: number, baseY: number, halfW: number, color: number, w: number, big: boolean): void {
  const o: StrokeOpts = { color, width: w * 0.8, jitter: 0.3, taper: 0.9, double: false };
  const spikes = 3;
  const peakY = baseY - halfW * (big ? 1.15 : 0.75);
  const dipY = baseY - halfW * (big ? 0.4 : 0.28);
  const pts: Pt[] = [{ x: cx - halfW, y: baseY }];
  for (let i = 0; i < spikes; i++) {
    const xm = cx - halfW + (halfW * 2 * (i + 0.5)) / spikes;
    const x1 = cx - halfW + (halfW * 2 * (i + 1)) / spikes;
    pts.push({ x: xm, y: i === 1 ? peakY : dipY });
    if (i < spikes - 1) pts.push({ x: x1, y: dipY + halfW * 0.3 });
  }
  pts.push({ x: cx + halfW, y: baseY });
  pen.stroke(pts, o);
  pen.line(cx - halfW * 1.05, baseY, cx + halfW * 1.05, baseY, o);
  if (big) pen.circle(cx, peakY + halfW * 0.14, halfW * 0.12, { ...o, width: w * 0.6 });
}

// ── Ladder ranks (bronze → king), escalating detail ─────────────────────────

export function drawTitleBronze(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x8f01);
  const w = Math.max(1.3, s * 0.045);
  const cx = s * 0.5, cy = s * 0.60, r = s * 0.20;
  ribbons(pen, s, color, w, false);
  discBody(g, pen, cx, cy, r, color, w, 0.12, false);
}

export function drawTitleSilver(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x8f02);
  const w = Math.max(1.3, s * 0.045);
  const cx = s * 0.5, cy = s * 0.60, r = s * 0.20;
  ribbons(pen, s, color, w, false);
  discBody(g, pen, cx, cy, r, color, w, 0.16, true);
}

export function drawTitleGold(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x8f03);
  const w = Math.max(1.3, s * 0.045);
  const cx = s * 0.5, cy = s * 0.60, r = s * 0.20;
  ribbons(pen, s, color, w, true);
  discBody(g, pen, cx, cy, r, color, w, 0.22, true);
  const sp = r * 0.32;
  pen.line(cx - sp, cy, cx + sp, cy, { color, width: w * 0.55, jitter: 0.2, taper: 0.25, double: false, alpha: 0.6 });
  pen.line(cx, cy - sp, cx, cy + sp, { color, width: w * 0.55, jitter: 0.2, taper: 0.25, double: false, alpha: 0.6 });
}

export function drawTitlePlatinum(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x8f04);
  const w = Math.max(1.3, s * 0.045);
  const cx = s * 0.5, cy = s * 0.60, r = s * 0.21;
  ribbons(pen, s, color, w, true);
  hexBody(g, pen, cx, cy, r, color, w, 0.24, true);
  facets(pen, cx, cy, r, 6, color, w);
}

export function drawTitleDiamond(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x8f05);
  const w = Math.max(1.3, s * 0.045);
  const cx = s * 0.5, cy = s * 0.60, r = s * 0.21;
  ribbons(pen, s, color, w, true);
  discBody(g, pen, cx, cy, r, color, w, 0.28, true);
  facets(pen, cx, cy, r, 8, color, w);
}

export function drawTitleStar(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x8f06);
  const w = Math.max(1.3, s * 0.045);
  const cx = s * 0.5, cy = s * 0.60, r = s * 0.23;
  ribbons(pen, s, color, w, true);
  starBody(g, pen, cx, cy, r, color, w, 0.30);
}

export function drawTitleMaster(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x8f07);
  const w = Math.max(1.3, s * 0.048);
  const cx = s * 0.5, cy = s * 0.62, r = s * 0.19;
  ribbons(pen, s, color, w, true);
  discBody(g, pen, cx, cy, r, color, w, 0.32, true);
  laurel(pen, cx, cy, r, 2, color, w);
}

export function drawTitleGrandmaster(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x8f08);
  const w = Math.max(1.3, s * 0.05);
  const cx = s * 0.5, cy = s * 0.64, r = s * 0.185;
  ribbons(pen, s, color, w, true);
  discBody(g, pen, cx, cy, r, color, w, 0.36, true);
  laurel(pen, cx, cy, r, 3, color, w);
  crown(pen, cx, cy - r, r * 1.1, color, w, false);
}

export function drawTitleKing(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x8f09);
  const w = Math.max(1.3, s * 0.052);
  const cx = s * 0.5, cy = s * 0.66, r = s * 0.18;
  burst(pen, cx, cy, r, color, w);
  ribbons(pen, s, color, w, true);
  discBody(g, pen, cx, cy, r, color, w, 0.40, true);
  laurel(pen, cx, cy, r, 4, color, w);
  crown(pen, cx, cy - r, r * 1.2, color, w, true);
}

// ── SLG season titles — shield silhouette distinguishes them from ladder medals ────

export function drawTitleChampion(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x8f0a);
  const w = Math.max(1.3, s * 0.05);
  const cx = s * 0.5, cy = s * 0.58, halfW = s * 0.20, halfH = s * 0.22;
  shieldBody(g, pen, cx, cy, halfW, halfH, color, w, 0.35, true);
  laurel(pen, cx, cy, halfW, 3, color, w);
  crown(pen, cx, cy - halfH, halfW * 1.1, color, w, true);
}

export function drawTitleTop3(g: PIXI.Graphics, s: number, color: number): void {
  const pen = new SketchPen(g, 0x8f0b);
  const w = Math.max(1.3, s * 0.045);
  const cx = s * 0.5, cy = s * 0.58, halfW = s * 0.19, halfH = s * 0.21;
  shieldBody(g, pen, cx, cy, halfW, halfH, color, w, 0.18, false);
  laurel(pen, cx, cy, halfW, 1, color, w);
}
