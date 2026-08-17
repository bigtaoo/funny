// tileGraphics/primitives — generic geometric drawing helpers shared across the world map's
// tile/overlay rendering. Pure PIXI Graphics functions; hold no scene state.
import * as PIXI from 'pixi.js-legacy';
import { ISO_RATIO } from '../../../render/isoGrid';

/**
 * ADR-026 §1: a small building-HP bar near the bottom of an attackable tile. Green→amber→red by ratio,
 * so an enemy base being ground down under a siege reads at a glance. Width scales with the tile size.
 */

export function drawHpBar(g: PIXI.Graphics, hp: number, maxHp: number, tp: number): void {
  // `g`'s local origin is the tile's diamond center (see drawTileL1); the bar sits just
  // above the diamond's bottom vertex instead of the old square's bottom edge.
  const hh = (tp * ISO_RATIO) / 2;
  const ratio = Math.max(0, Math.min(1, hp / maxHp));
  const barW = tp * 0.7;
  const barH = Math.max(3, tp * 0.06);
  const x = -barW / 2;
  const y = hh - barH - 3;
  // Track
  g.lineStyle(0.6, 0x3a2a1a, 0.8);
  g.beginFill(0x2a1e12, 0.75);
  g.drawRect(x, y, barW, barH);
  g.endFill();
  // Fill: green (full) → amber (mid) → red (low)
  const fillColor = ratio > 0.5 ? 0x3aa03a : (ratio > 0.25 ? 0xd8a520 : 0xcc2222);
  g.lineStyle(0);
  g.beginFill(fillColor, 0.95);
  g.drawRect(x, y, barW * ratio, barH);
  g.endFill();
}

// ── L3 overview (batched Graphics) ─────────────────────────────────────────
// Renders on a dirty flag in update(), so mousemove spam doesn't trigger it.
// Tiles grouped by color → one beginFill + N drawRect per color group (fast).

export function drawStar(g: PIXI.Graphics, cx: number, cy: number, r: number, color: number, filled: boolean): void {
  const pts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    // Deterministic per-vertex radius jitter (index-seeded, position-independent) so the
    // star reads as hand-drawn ink like the rest of the map, yet stays stable across the
    // ~5s overlay redraws and while panning — no shimmer.
    const h = Math.sin(i * 12.9898) * 43758.5453;
    const wob = ((h - Math.floor(h)) - 0.5) * r * 0.14;
    pts.push(cx + Math.cos(a) * (rad + wob), cy + Math.sin(a) * (rad + wob));
  }
  g.lineStyle(1.5, 0x6a5a20, 0.9);
  if (filled) g.beginFill(color, 0.95);
  g.drawPolygon(pts);
  if (filled) g.endFill();
}

/**
 * Dashed stroke along a closed polygon's perimeter (caller sets `g.lineStyle` beforehand —
 * this only decides which sub-segments are visible, not color/width). `pts` is a flat
 * [x0,y0,x1,y1,...] point list, implicitly closed back to the first point. The dash phase
 * runs continuously across the whole perimeter instead of resetting at each vertex, so
 * corners don't bunch up a partial dash/gap — used to give overlay layers (occupy frontier,
 * garrison zones) a distinct stroke language from solid territory borders (2026-08-01,
 * "地图看起来有些混乱" declutter pass).
 */
export function drawDashedPolygon(g: PIXI.Graphics, pts: number[], dashLen: number, gapLen: number): void {
  const n = pts.length / 2;
  const cycle = dashLen + gapLen;
  if (n < 2 || cycle <= 0) return;
  let phase = 0; // position within [0, cycle) — carried across edges, never reset per-edge
  for (let i = 0; i < n; i++) {
    const x0 = pts[i * 2]!, y0 = pts[i * 2 + 1]!;
    const j = (i + 1) % n;
    const x1 = pts[j * 2]!, y1 = pts[j * 2 + 1]!;
    const dx = x1 - x0, dy = y1 - y0;
    const edgeLen = Math.hypot(dx, dy);
    if (edgeLen === 0) continue;
    const ux = dx / edgeLen, uy = dy / edgeLen;
    let t = 0;
    while (t < edgeLen) {
      const inDash = phase < dashLen;
      const segCap = inDash ? dashLen - phase : cycle - phase;
      const segLen = Math.min(segCap, edgeLen - t);
      if (inDash) {
        g.moveTo(x0 + ux * t, y0 + uy * t);
        g.lineTo(x0 + ux * (t + segLen), y0 + uy * (t + segLen));
      }
      t += segLen;
      phase = (phase + segLen) % cycle;
    }
  }
}

/**
 * Corner-bracket stroke: instead of tracing a polygon's whole perimeter, draw only a short stub
 * out of each vertex along both adjacent edges (`tickFrac` of that edge's length, capped at half
 * so opposite ticks never meet). Caller sets `g.lineStyle` beforehand.
 *
 * This is the quietest way to mark "this cell is a candidate" (2026-08-17, "可以攻打的地块的突出
 * 显示方式换个形式，目前太显眼了"): the eye reads a repeated bracket motif as one band at a glance,
 * but there's no continuous rope of dashes competing with the map's own ink for focus. Adjacent
 * candidate cells share vertices, so their ticks coalesce into small crosses along the band —
 * intentional, it makes the band's extent readable without any long stroke.
 */
export function drawPolygonCornerTicks(g: PIXI.Graphics, pts: number[], tickFrac: number): void {
  const n = pts.length / 2;
  if (n < 3) return;
  const f = Math.min(0.5, tickFrac);
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2]!, y = pts[i * 2 + 1]!;
    for (const j of [(i + 1) % n, (i + n - 1) % n]) {
      const dx = pts[j * 2]! - x, dy = pts[j * 2 + 1]! - y;
      g.moveTo(x, y);
      g.lineTo(x + dx * f, y + dy * f);
    }
  }
}

/**
 * A straight line whose width/alpha ramp from `startWidth/startAlpha` at (x0,y0) to
 * `endWidth/endAlpha` at (x1,y1), holding the end value for the final `holdFrac` of the
 * route so a destination marker (e.g. a march's arrowhead) never looks like it's still
 * fading in. Drawn as a fixed `segments` count of solid sub-segments (a stepped
 * approximation of a true gradient, same idea as this file's per-tile jitter techniques) —
 * fixed count keeps the draw-call cost bounded regardless of route length, so a long march
 * doesn't cost more than a short one. Used to de-emphasize march-route "tails" so multiple
 * routes converging on one tile don't read as a solid bundle (2026-08-01 declutter pass).
 */
export function drawFadedLine(
  g: PIXI.Graphics, x0: number, y0: number, x1: number, y1: number,
  color: number, startWidth: number, startAlpha: number,
  endWidth: number, endAlpha: number, holdFrac = 0.25, segments = 8,
): void {
  const dx = x1 - x0, dy = y1 - y0;
  const denom = Math.max(0.0001, 1 - holdFrac);
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const e1 = Math.min(1, t1 / denom); // eased toward 1 early so the tail holds at full strength
    const w = startWidth + (endWidth - startWidth) * e1;
    const a = startAlpha + (endAlpha - startAlpha) * e1;
    g.lineStyle(w, color, a);
    g.moveTo(x0 + dx * t0, y0 + dy * t0);
    g.lineTo(x0 + dx * t1, y0 + dy * t1);
  }
  g.lineStyle(0);
}
