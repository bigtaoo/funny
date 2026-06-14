/**
 * sketch.ts — hand-drawn brush-stroke primitives (PIXI.Graphics).
 *
 * The shared "pen" for the whole game's procedural art. Every stroke is:
 *   • resampled into short segments,
 *   • wobbled perpendicular to its direction by a deterministic Prng jitter,
 *   • tapered (thin at the ends, full width in the middle),
 *   • optionally double-traced (a faint ghost pass) for a sketched feel.
 *
 * Determinism: callers pass a `seed` so the exact same scrawl is reproduced
 * across re-draws / bakes. We wrap the game `Prng` (no Math.random) so a baked
 * board looks identical every battle while still varying mark-to-mark.
 *
 * This module draws — it knows nothing about layout or baking. Static art
 * drawn with it gets baked to a texture by `bake.ts`; dynamic overlays draw
 * with it live.
 */
import * as PIXI from 'pixi.js-legacy';
import { Prng } from '../game/math/prng';
import { pen as PEN, hatchDefaults, palette } from './theme';

export interface StrokeOpts {
  color?:  number;
  /** Center line width; ends taper to `taper × width`. */
  width?:  number;
  alpha?:  number;
  /** Perpendicular wobble amplitude (px). */
  jitter?: number;
  /** End taper factor (0 = sharp point, 1 = no taper). */
  taper?:  number;
  /** Draw a faint offset ghost pass for a doubled, sketchy line. */
  double?: boolean;
}

export interface Point { x: number; y: number; }

/** Deterministic float in [0, 1) wrapping the game Prng (visual-only use). */
function frand(p: Prng): number {
  return p.nextInt(0x100000) / 0x100000;
}

/** Signed jitter in [-amp, amp]. */
function jrand(p: Prng, amp: number): number {
  return (frand(p) * 2 - 1) * amp;
}

/**
 * A reusable pen bound to a Graphics target and a seeded Prng.
 * Construct one per static drawing so the seed → look mapping is stable.
 */
export class SketchPen {
  private readonly g:    PIXI.Graphics;
  private readonly prng: Prng;

  constructor(g: PIXI.Graphics, seed = 1) {
    this.g    = g;
    this.prng = new Prng(seed >>> 0 || 1);
  }

  /** Densify a polyline so each gap is ~segLen long (for smooth wobble). */
  private resample(pts: Point[], segLen: number): Point[] {
    const out: Point[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.round(len / segLen));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        out.push({ x: a.x + dx * t, y: a.y + dy * t });
      }
    }
    out.push(pts[pts.length - 1]!);
    return out;
  }

  /** Offset each interior point perpendicular to the local direction. */
  private wobble(pts: Point[], jitter: number): Point[] {
    if (pts.length < 2) return pts;
    const out: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)]!;
      const next = pts[Math.min(pts.length - 1, i + 1)]!;
      let nx = -(next.y - prev.y), ny = next.x - prev.x;
      const nlen = Math.hypot(nx, ny) || 1;
      nx /= nlen; ny /= nlen;
      // Endpoints barely move so connected shapes still meet at corners.
      const edge = i === 0 || i === pts.length - 1 ? 0.25 : 1;
      const off = jrand(this.prng, jitter) * edge;
      out.push({ x: pts[i]!.x + nx * off, y: pts[i]!.y + ny * off });
    }
    return out;
  }

  /** One tapered pass along an already-prepared point list. */
  private trace(pts: Point[], color: number, width: number, alpha: number, taper: number): void {
    const g = this.g;
    const n = pts.length;
    if (n < 2) return;
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      // Taper: thin near both ends, full width in the middle.
      const t = i / (n - 2 || 1);
      const env = Math.sin(Math.PI * t);          // 0→1→0 across the stroke
      const w = width * (taper + (1 - taper) * env);
      g.lineStyle({ width: w, color, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
    }
  }

  /** Draw a hand-drawn stroke through the given polyline. */
  stroke(points: Point[], opts: StrokeOpts = {}): this {
    const color  = opts.color  ?? 0x3a3632;
    const width  = opts.width  ?? PEN.width;
    const alpha  = opts.alpha  ?? 1;
    const jitter = opts.jitter ?? PEN.jitter;
    const taper  = opts.taper  ?? PEN.taper;

    const base = this.wobble(this.resample(points, PEN.segLen), jitter);
    this.trace(base, color, width, alpha, taper);

    if (opts.double ?? true) {
      // Ghost pass: independent jitter + slight offset, fainter.
      const ghost = this.wobble(this.resample(points, PEN.segLen), jitter)
        .map(p => ({ x: p.x + jrand(this.prng, PEN.doubleOffset), y: p.y + jrand(this.prng, PEN.doubleOffset) }));
      this.trace(ghost, color, width * 0.85, alpha * PEN.ghostAlpha, taper);
    }
    return this;
  }

  /** Convenience: a single hand-drawn segment. */
  line(x1: number, y1: number, x2: number, y2: number, opts: StrokeOpts = {}): this {
    return this.stroke([{ x: x1, y: y1 }, { x: x2, y: y2 }], opts);
  }

  /**
   * A scribbled rectangle — four strokes whose corners overshoot slightly,
   * the way a hand lifts past the turn. Good for doodle-frame buttons / boxes.
   */
  rect(x: number, y: number, w: number, h: number, opts: StrokeOpts = {}): this {
    const o = () => jrand(this.prng, 2.5);   // corner overshoot
    this.stroke([{ x: x + o(), y }, { x: x + w + o(), y }], opts);
    this.stroke([{ x: x + w, y: y + o() }, { x: x + w, y: y + h + o() }], opts);
    this.stroke([{ x: x + w + o(), y: y + h }, { x: x + o(), y: y + h }], opts);
    this.stroke([{ x, y: y + h + o() }, { x, y: y + o() }], opts);
    return this;
  }

  /**
   * A hand-drawn circle — a closed wobbled polygon that overshoots its start
   * slightly, the way a hand loops past where it began. Used for joints, heads
   * and base/building outlines so round shapes share the same pen as everything
   * else (art-direction §4.1 / §6.3).
   */
  circle(cx: number, cy: number, r: number, opts: StrokeOpts = {}): this {
    const steps = Math.max(10, Math.round(r * 0.9));
    const pts: Point[] = [];
    // Start angle jittered + ~20° overshoot past 2π so the loop closes by hand.
    const a0 = frand(this.prng) * Math.PI * 2;
    const end = Math.PI * 2 + 0.35;
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (end * i) / steps;
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return this.stroke(pts, opts);
  }

  /**
   * Parallel pencil hatch lines clipped to a rect — flat shading, no gradient.
   * Angle defaults to 45°; pass a second call at the opposite angle for cross-hatch.
   */
  hatch(
    x: number, y: number, w: number, h: number,
    opts: { color?: number; spacing?: number; angle?: number; width?: number; alpha?: number } = {},
  ): this {
    const color   = opts.color   ?? 0x8a8278;
    const spacing = opts.spacing ?? hatchDefaults.spacing;
    const angle   = opts.angle   ?? hatchDefaults.angle;
    const width   = opts.width   ?? hatchDefaults.width;
    const alpha   = opts.alpha   ?? hatchDefaults.alpha;

    const dx = Math.cos(angle), dy = Math.sin(angle);
    // March a family of parallel lines across the rect's diagonal extent.
    const diag = Math.abs(w * dx) + Math.abs(h * dy) + Math.abs(w * dy) + Math.abs(h * dx);
    const px = -dy, py = dx;   // line direction (perpendicular to march)
    const cx = x + w / 2, cy = y + h / 2;
    for (let d = -diag / 2; d <= diag / 2; d += spacing) {
      const mx = cx + dx * d, my = cy + dy * d;
      const seg = clipLineToRect(mx, my, px, py, x, y, w, h);
      if (seg) this.stroke([seg[0], seg[1]], { color, width, alpha, taper: 0.7, double: false });
    }
    return this;
  }
}

/**
 * Clip an infinite line (point + direction) to an axis-aligned rect.
 * Returns the two intersection endpoints, or null if it misses.
 */
function clipLineToRect(
  ox: number, oy: number, dx: number, dy: number,
  rx: number, ry: number, rw: number, rh: number,
): [Point, Point] | null {
  // Liang–Barsky against the rect.
  let t0 = -Infinity, t1 = Infinity;
  const p = [-dx, dx, -dy, dy];
  const q = [ox - rx, rx + rw - ox, oy - ry, ry + rh - oy];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i]! < 0) return null; }
    else {
      const r = q[i]! / p[i]!;
      if (p[i]! < 0) t0 = Math.max(t0, r);
      else           t1 = Math.min(t1, r);
    }
  }
  if (t0 > t1) return null;
  return [
    { x: ox + dx * t0, y: oy + dy * t0 },
    { x: ox + dx * t1, y: oy + dy * t1 },
  ];
}

/**
 * Demo sampler — draws a labelled grid of the pen's repertoire into `g`.
 * Wired by the `?sketch` boot path so the look can be eyeballed in isolation.
 */
export function drawSketchDemo(g: PIXI.Graphics, w: number, h: number): void {
  const pen = new SketchPen(g, 42);

  // Single tapered ink strokes, varying width.
  pen.line(60, 80, w - 60, 90, { color: palette.pencil, width: 2.2 });
  pen.line(60, 130, w - 60, 150, { color: palette.inkBlue, width: 3.5 });
  pen.line(60, 190, w - 60, 175, { color: palette.inkRed, width: 3.5 });

  // A wavy multi-point stroke.
  const wave: Point[] = [];
  for (let i = 0; i <= 10; i++) wave.push({ x: 60 + i * (w - 120) / 10, y: 260 + Math.sin(i) * 30 });
  pen.stroke(wave, { color: palette.pencil, width: 2.6 });

  // Scribbled doodle-frame box.
  pen.rect(60, 320, 200, 120, { color: palette.inkBlue, width: 2.4 });

  // Cross-hatched shaded box.
  pen.rect(320, 320, 200, 120, { color: palette.pencil, width: 2.4 });
  pen.hatch(330, 330, 180, 100, { color: palette.pencilLight, angle: Math.PI / 4 });
  pen.hatch(330, 330, 180, 100, { color: palette.pencilLight, angle: -Math.PI / 4 });

  // Marker accent underline.
  pen.line(60, 490, 300, 490, { color: palette.marker, width: 6, taper: 0.6, double: false });
}
