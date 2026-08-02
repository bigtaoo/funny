// Legendary-card border trail — pure geometry + colour helpers shared by the reveal mixin
// (which builds the trails) and the base's update() loop (which advances them every frame).
// No class state: a rounded-rect perimeter walker plus the foil-shimmer hue cycle.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';

/**
 * Legendary-card border trail: N pooled dot sprites walking a rounded-rect
 * perimeter. `phase` is the comet head's position as a fraction of the total
 * perimeter length (0..1, wraps); each dot in `dots` trails behind the head by
 * an even fraction of TRAIL_SPAN, recomputed analytically every frame in
 * update() — see {@link pointOnPerim}. No Graphics redraw, no mask: the dots
 * are mathematically constrained to the border so they never bleed off-card.
 */
export interface LegendaryTrail { dots: PIXI.Sprite[]; perim: RectPerim; phase: number; }

/** One straight edge or one rounded corner of a rect perimeter, each carrying its own arc length. */
export type PerimSeg =
  | { kind: 'line'; x0: number; y0: number; x1: number; y1: number; len: number }
  | { kind: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number; len: number };

export interface RectPerim { segs: PerimSeg[]; total: number; }

/** Walk a rounded rect (x,y,w,h, corner radius r) clockwise from the top edge as 8 segments (4 lines + 4 corner arcs). */
export function buildRectPerim(x: number, y: number, w: number, h: number, r: number): RectPerim {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const arcLen = (rr * Math.PI) / 2;
  const segs: PerimSeg[] = [
    { kind: 'line', x0: x + rr, y0: y, x1: x + w - rr, y1: y, len: w - 2 * rr },
    { kind: 'arc', cx: x + w - rr, cy: y + rr, r: rr, a0: -Math.PI / 2, a1: 0, len: arcLen },
    { kind: 'line', x0: x + w, y0: y + rr, x1: x + w, y1: y + h - rr, len: h - 2 * rr },
    { kind: 'arc', cx: x + w - rr, cy: y + h - rr, r: rr, a0: 0, a1: Math.PI / 2, len: arcLen },
    { kind: 'line', x0: x + w - rr, y0: y + h, x1: x + rr, y1: y + h, len: w - 2 * rr },
    { kind: 'arc', cx: x + rr, cy: y + h - rr, r: rr, a0: Math.PI / 2, a1: Math.PI, len: arcLen },
    { kind: 'line', x0: x, y0: y + h - rr, x1: x, y1: y + rr, len: h - 2 * rr },
    { kind: 'arc', cx: x + rr, cy: y + rr, r: rr, a0: Math.PI, a1: Math.PI * 1.5, len: arcLen },
  ];
  return { segs, total: segs.reduce((s, seg) => s + seg.len, 0) };
}

/** Position on `perim` at arc-length fraction `u` (wraps mod 1, negative-safe). */
export function pointOnPerim(perim: RectPerim, u: number): { x: number; y: number } {
  let d = (((u % 1) + 1) % 1) * perim.total;
  for (const seg of perim.segs) {
    if (d <= seg.len) {
      const f = seg.len > 0 ? d / seg.len : 0;
      return seg.kind === 'line'
        ? { x: seg.x0 + (seg.x1 - seg.x0) * f, y: seg.y0 + (seg.y1 - seg.y0) * f }
        : { x: seg.cx + Math.cos(seg.a0 + (seg.a1 - seg.a0) * f) * seg.r, y: seg.cy + Math.sin(seg.a0 + (seg.a1 - seg.a0) * f) * seg.r };
    }
    d -= seg.len;
  }
  const last = perim.segs[perim.segs.length - 1];
  return last.kind === 'line' ? { x: last.x1, y: last.y1 } : { x: last.cx + Math.cos(last.a1) * last.r, y: last.cy + Math.sin(last.a1) * last.r };
}

/** Soft white radial-gradient dot (baked once, see uiCache); tinted per trail position/time and scaled by tail falloff. */
export function drawTrailDotGraphic(): PIXI.Graphics {
  const g = new PIXI.Graphics();
  const R = 32;
  const rings = 10;
  for (let i = rings; i >= 1; i--) {
    const f = i / rings;
    g.beginFill(0xffffff, (1 - f) * (1 - f));
    g.drawCircle(R, R, R * f);
    g.endFill();
  }
  return g;
}

// ── Legendary border-trail tuning ───────────────────────────────────────────
/** Loops of the card's border per second for the trail's comet head. Positive = clockwise (screen y-down). */
export const TRAIL_SPEED = 0.28;
/** Inward offset (px) from the card's edge the trail loops on, so it doesn't ride the frame's outer lip. */
export const TRAIL_INSET = 16;
/** Fading dots making up the comet's tail — more = smoother trail. */
export const TRAIL_DOTS = 28;
/** Tail length as a fraction of the full perimeter, head to faded tail-end. */
export const TRAIL_SPAN = 0.42;
/** Full rainbow cycles painted around one lap of the border — a "holographic foil" shimmer, not a flat gold tint. */
export const TRAIL_HUE_CYCLES = 2;
/** Slow independent drift (laps/s) of the hue pattern itself, so the shimmer keeps creeping instead of freezing to the border. */
export const TRAIL_HUE_DRIFT = 0.0333;
/** Perimeter-fraction head start of the second trail relative to the first (0.5 = half a lap, i.e. diagonally opposite corners). */
export const TRAIL_PAIR_OFFSET = 0.5;

/** HSL (h,s,l ∈ [0,1]) → 0xRRGGBB, used for the trail's periodic foil-shimmer hue cycle. */
export function hslToHex(h: number, s: number, l: number): number {
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = ((t % 1) + 1) % 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
  return (r << 16) | (g << 8) | b;
}

/** Hue (0..1) for the dot currently at perimeter fraction `u`, given the head's current lap `phase`. */
export function trailHue(u: number, phase: number): number {
  const uw = ((u % 1) + 1) % 1;
  return ((uw * TRAIL_HUE_CYCLES + phase * TRAIL_HUE_DRIFT) % 1 + 1) % 1;
}
