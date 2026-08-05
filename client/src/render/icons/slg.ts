/**
 * slg.ts — SLG march-kind glyph (flag) + city building glyphs
 * (desk / cabinet / hammer) + the header-shop timer glyph (hourglass).
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from '../sketch';

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

/**
 * Hourglass (shop: troop training speedup) — a wood-capped sand-timer with
 * settled + remaining sand, grains falling through the neck, and trailing
 * speed ticks off the right edge so it reads as "time, accelerated" rather
 * than the bare motion chevrons used for the unit move-speed stat.
 *
 * `pile` scales how full the glass reads and `ticks` how many speed-lines
 * trail off it — the escalating-richness idiom `currency.ts` uses for the
 * coin recharge ladder (coin→coins→coinStack→coinSack→coinChest), applied
 * here so the 1h/8h/24h speedup tiers don't share one identical glyph.
 */
function hourglassCore(g: PIXI.Graphics, s: number, color: number, pile: number, ticks: number): void {
  const pen = new SketchPen(g, 0x9a2c);
  const w = Math.max(1.4, s * 0.05);
  const o = { color, width: w, jitter: 0.4, taper: 0.9, double: false };
  const cx = s * 0.42, lx = s * 0.22, rx = s * 0.62, top = s * 0.20, bot = s * 0.80, midY = s * 0.50, neck = s * 0.03;

  // Glass body — top bulb tapering to the neck, mirrored below.
  pen.stroke([
    { x: lx, y: top }, { x: rx, y: top }, { x: cx + neck, y: midY },
    { x: rx, y: bot }, { x: lx, y: bot }, { x: cx - neck, y: midY }, { x: lx, y: top },
  ], o);
  // Wood end-caps, slightly overhanging the glass.
  pen.line(lx - s * 0.05, top, rx + s * 0.05, top, { ...o, width: w * 1.1 });
  pen.line(lx - s * 0.05, bot, rx + s * 0.05, bot, { ...o, width: w * 1.1 });

  // Settled sand pile at the bottom (filled) — apex rises toward the neck as `pile` grows.
  g.beginFill(color, 0.85); g.lineStyle(0);
  g.drawPolygon([lx + s * 0.05, bot - s * 0.02, rx - s * 0.05, bot - s * 0.02, cx, midY + s * 0.14 * pile]);
  g.endFill();
  // Remaining sand at the top (filled, fainter) — same escalation, mirrored.
  g.beginFill(color, 0.5); g.lineStyle(0);
  g.drawPolygon([lx + s * 0.07, top + s * 0.03, rx - s * 0.07, top + s * 0.03, cx, midY - s * 0.10 * pile]);
  g.endFill();

  // Grains falling through the neck — one per tier.
  for (let i = 0; i < ticks; i++) {
    pen.circle(cx, midY - s * 0.02 + i * s * 0.09, Math.max(1, s * 0.018), { ...o, width: w * 0.6 });
  }

  // Speed ticks trailing off the right side — the "accelerated" cue, one more per tier.
  const tickYs = [s * 0.36, s * 0.50, s * 0.64].slice(0, ticks);
  for (const oy of tickYs) {
    pen.line(rx + s * 0.12, oy, rx + s * 0.24, oy, { ...o, width: w * 0.65, taper: 0.4, alpha: 0.75 });
  }
}

/** Hourglass, light — thin sand, a single grain + tick (shortest speedup tier). */
export function drawHourglassSm(g: PIXI.Graphics, s: number, color: number): void {
  hourglassCore(g, s, color, 0.65, 1);
}

/** Hourglass, half-full — the mid speedup tier. */
export function drawHourglassMd(g: PIXI.Graphics, s: number, color: number): void {
  hourglassCore(g, s, color, 1.0, 2);
}

/** Hourglass, brimming — thick sand piles + a full trail of speed ticks (longest tier). */
export function drawHourglassLg(g: PIXI.Graphics, s: number, color: number): void {
  hourglassCore(g, s, color, 1.35, 3);
}
