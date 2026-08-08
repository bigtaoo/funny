// Capital-protection shield bubble — drawn over a base's city sprite while its `protectedUntil`
// is in the future (S8-8 UI fix, 2026-08-08). Originally just a translucent ellipse redrawn only
// when something else triggered refreshCityLayer (pan/zoom/poll), so it sat visually frozen most
// of the time and read as a flat static overlay rather than an active field ("现在就叠加了一张图，
// 不太能懂用途是什么" follow-up, 2026-08-08). Now redrawn every frame from lifecycle.update using a
// plain elapsed-seconds clock (ShieldGeom cached per-base in WorldMapContext.shieldGeom), so the
// dashed ring visibly spins and the dome visibly breathes — reads as "a field is up", not a sticker.
//
// Split into three layers (2026-08-08 follow-up, borrowing the additive-glow + break-flash idea
// from D:\daydayup's EnergyShieldFilter/FxController.flash — see SLG_DESIGN_LOG.md for the writeup
// of why a custom Pixi Filter itself wasn't worth porting: this project has no shader pipeline, and
// the per-object render-target cost a Filter needs isn't worth it for a effect this simple):
//   - shieldFx (dome): normal-blend translucent fill/stroke, so it still reads as "glass sitting on
//     the paper" rather than a glow — kept as its own draw call so existing tests (which spy on this
//     Graphics' drawEllipse) stay meaningful.
//   - shieldGlowFx (rotating dashed ring + sparkle ticks): additive blend, same trick daydayup and
//     GachaScene/reveal.ts already use for "this should glow, not just be translucent" accents.
//   - shieldBreakFx (one-shot pop when protection just expired): additive, self-destructs.
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

/** Dome: translucent fill + soft edge, breathing alpha. Single drawEllipse call — the one
 *  authoritative "shield outline" draw (tests spy on this specifically). Normal blend mode
 *  (set once at creation, not here) — this is the "glass", not the "glow". */
export function drawShieldDome(g: PIXI.Graphics, geom: ShieldGeom, t: number): void {
  const { cx, cy, rx, ry, tp } = geom;
  g.clear();
  const breathe = 0.5 + 0.5 * Math.sin(t * 1.3);
  g.lineStyle(Math.max(1.5, tp * 0.02), 0x5fd4ff, 0.55 + 0.2 * breathe);
  g.beginFill(0x5fd4ff, 0.08 + 0.05 * breathe);
  g.drawEllipse(cx, cy, rx, ry);
  g.endFill();
}

/** Rotating dashed ring + counter-rotating sparkle ticks, just outside the dome — same hand-drawn
 *  dashed-boundary motif as the territory outline (tileStyle.ts), spinning slowly so the bubble
 *  reads as an active field. Additive blend (set once at creation) makes this layer actually glow
 *  against the paper background instead of just looking like more translucent ink. */
export function drawShieldGlow(g: PIXI.Graphics, geom: ShieldGeom, t: number): void {
  const { cx, cy, rx, ry, tp } = geom;
  g.clear();
  const breathe = 0.5 + 0.5 * Math.sin(t * 1.3);

  const DASH_COUNT = 16;
  const DASH_FRAC = 0.5;
  const spin = t * 0.6;
  g.lineStyle(Math.max(1, tp * 0.015), 0x8fe6ff, 0.5 + 0.3 * breathe);
  for (let i = 0; i < DASH_COUNT; i++) {
    const a0 = spin + (i / DASH_COUNT) * Math.PI * 2;
    const a1 = a0 + ((Math.PI * 2) / DASH_COUNT) * DASH_FRAC;
    g.moveTo(cx + Math.cos(a0) * rx * 1.05, cy + Math.sin(a0) * ry * 1.05);
    g.lineTo(cx + Math.cos(a1) * rx * 1.05, cy + Math.sin(a1) * ry * 1.05);
  }

  const sparkleR = Math.max(1.2, tp * 0.03);
  for (let i = 0; i < 4; i++) {
    const a = spin * -1.3 + (i / 4) * Math.PI * 2;
    const tw = 0.5 + 0.5 * Math.sin(t * 2.2 + i * 1.7);
    g.beginFill(0xdff8ff, 0.3 + 0.4 * tw);
    g.drawCircle(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, sparkleR * (0.6 + 0.4 * tw));
    g.endFill();
  }
}

/** Seconds the one-shot "shield just broke" pop lasts — see WorldMapContext.shieldBreakFx. */
export const SHIELD_BREAK_LIFE = 0.4;

/** One-shot expanding/fading ring burst for the instant a base's protection lapses — borrowed
 *  from daydayup's `shield_break` flash (concentric rings, additive, ~170ms). Ours runs a bit
 *  longer (400ms) since the dome itself is bigger on-screen than a twin-stick character sprite.
 *  `age` is seconds since the break was first observed; caller removes the entry once it exceeds
 *  SHIELD_BREAK_LIFE. */
export function drawShieldBreakFx(g: PIXI.Graphics, geom: ShieldGeom, age: number): void {
  const { cx, cy, rx, ry, tp } = geom;
  g.clear();
  const p = Math.min(1, age / SHIELD_BREAK_LIFE);
  const fade = 1 - p;
  if (fade <= 0) return;
  const RINGS = 3;
  for (let i = 0; i < RINGS; i++) {
    const spread = p * (1 + i * 0.35);
    const ringFade = fade * (1 - i * 0.25);
    if (ringFade <= 0) continue;
    g.lineStyle(Math.max(1, tp * 0.03) * fade, 0xbdf2ff, 0.8 * ringFade);
    g.drawEllipse(cx, cy, rx * (1 + spread * 0.5), ry * (1 + spread * 0.5));
  }
}
