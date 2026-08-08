// Capital-protection shield bubble — drawn over a base's city sprite while its `protectedUntil`
// is in the future (S8-8 UI fix, 2026-08-08). Originally just a translucent ellipse redrawn only
// when something else triggered refreshCityLayer (pan/zoom/poll), so it sat visually frozen most
// of the time and read as a flat static overlay rather than an active field ("现在就叠加了一张图，
// 不太能懂用途是什么" follow-up, 2026-08-08). Now redrawn every frame from lifecycle.update using a
// plain elapsed-seconds clock (ShieldGeom cached per-base in WorldMapContext.shieldGeom), so the
// dashed ring visibly spins and the dome visibly breathes — reads as "a field is up", not a sticker.
import * as PIXI from 'pixi.js-legacy';

export interface ShieldGeom {
  /** Local-space center/radii, relative to the city container (cityC) — NOT screen coordinates,
   *  so this stays valid across pan/zoom without recomputation; only refreshCityLayer recomputes
   *  it (sprite size changed). */
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Current TILE_PX, for scaling stroke widths/sparkle size to zoom level. */
  tp: number;
}

/** Redraws one shield bubble in-place. `t` is elapsed seconds (ctx.shieldAnimT) — a slow dashed
 *  ring rotation plus a soft breathing pulse on the dome fill/stroke, with four faint sparkle
 *  ticks riding the ring out of phase so it doesn't read as a uniform spinning circle. */
export function drawShieldFx(g: PIXI.Graphics, geom: ShieldGeom, t: number): void {
  const { cx, cy, rx, ry, tp } = geom;
  g.clear();

  const breathe = 0.5 + 0.5 * Math.sin(t * 1.3);

  // Dome: translucent fill + soft edge, breathing alpha. Single drawEllipse call — kept as the
  // one authoritative "shield outline" draw (tests spy on this specifically).
  g.lineStyle(Math.max(1.5, tp * 0.02), 0x5fd4ff, 0.55 + 0.2 * breathe);
  g.beginFill(0x5fd4ff, 0.08 + 0.05 * breathe);
  g.drawEllipse(cx, cy, rx, ry);
  g.endFill();

  // Rotating dashed ring, just outside the dome — same hand-drawn dashed-boundary motif as the
  // territory outline (tileStyle.ts), spinning slowly so the bubble reads as an active field.
  const DASH_COUNT = 16;
  const DASH_FRAC = 0.5;
  const spin = t * 0.6;
  g.lineStyle(Math.max(1, tp * 0.015), 0x8fe6ff, 0.6 + 0.3 * breathe);
  for (let i = 0; i < DASH_COUNT; i++) {
    const a0 = spin + (i / DASH_COUNT) * Math.PI * 2;
    const a1 = a0 + ((Math.PI * 2) / DASH_COUNT) * DASH_FRAC;
    g.moveTo(cx + Math.cos(a0) * rx * 1.05, cy + Math.sin(a0) * ry * 1.05);
    g.lineTo(cx + Math.cos(a1) * rx * 1.05, cy + Math.sin(a1) * ry * 1.05);
  }

  // Four sparkle ticks riding the ring, counter-rotating and twinkling out of phase — a small
  // "warded" detail so the effect doesn't just look like a spinning outline.
  const sparkleR = Math.max(1.2, tp * 0.03);
  for (let i = 0; i < 4; i++) {
    const a = spin * -1.3 + (i / 4) * Math.PI * 2;
    const tw = 0.5 + 0.5 * Math.sin(t * 2.2 + i * 1.7);
    g.beginFill(0xdff8ff, 0.35 + 0.45 * tw);
    g.drawCircle(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, sparkleR * (0.6 + 0.4 * tw));
    g.endFill();
  }
}
