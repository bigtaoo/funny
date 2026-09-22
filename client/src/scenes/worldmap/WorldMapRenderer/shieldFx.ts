// Capital-protection shield bubble — drawn over a base's city sprite while its `protectedUntil`
// is in the future (S8-8 UI fix, 2026-08-08). Originally just a translucent ellipse redrawn only
// when something else triggered refreshCityLayer (pan/zoom/poll), so it sat visually frozen most
// of the time and read as a flat static overlay rather than an active field ("现在就叠加了一张图，
// 不太能懂用途是什么" follow-up, 2026-08-08).
//
// Split into three layers (2026-08-08 follow-up, borrowing the additive-glow + break-flash idea
// from D:\daydayup's EnergyShieldFilter/FxController.flash — see SLG_DESIGN_LOG.md for the writeup
// of why a custom Pixi Filter itself wasn't worth porting: this project has no shader pipeline, and
// the per-object render-target cost a Filter needs isn't worth it for an effect this simple):
//   - shieldFx (dome): normal-blend translucent fill/stroke, so it still reads as "glass sitting on
//     the paper" rather than a glow — kept as its own draw call so existing tests (which spy on this
//     Graphics' drawEllipse) stay meaningful.
//   - shieldGlowFx (rotating dashed ring + sparkle ticks): additive blend, same trick daydayup and
//     GachaScene/reveal.ts already use for "this should glow, not just be translucent" accents.
//   - shieldBreakFx (one-shot pop when protection just expired): additive, self-destructs.
//
// ── Why the moving parts animate by TRANSFORM, not by redraw (2026-09-22) ─────
//
// The first cut rebuilt both Graphics from scratch on every animation step, which capped the step
// rate at 10 fps to keep that rebuild affordable (client-render-budget.md §2). At 10 fps it read as
// broken rather than hand-drawn, and the reason is that this is the biggest moving thing on the
// map: the ring turns 0.6 rad/s at rx = 277 px (measured, landscape L1, tp = 206), so a 100 ms step
// walked each dash 16.6 px and each sparkle 21.6 px. Travel that far per step strobes;
// art-direction §5.4's "帧率保留手绘的跳跃感" is about ink that CHANGES SHAPE
// in place (render/boil.ts), not about something crossing the screen.
//
// So the geometry is now built once per layout refresh (`drawShieldDome` / `drawShieldGlow`, called
// from refreshCityLayer, which is also the only thing that knows rx/ry) and every animation step is
// pure `rotation` / `alpha` / `scale` writes (`animateShield`). Two consequences:
//   - A step costs a handful of property writes instead of two full Graphics tessellations, so the
//     rate is now limited only by how often we're willing to PAINT (lifecycle.ts SHIELD_ANIM_FPS).
//   - The ring has to spin as a CIRCLE and get squashed afterwards, because PIXI's local transform
//     is T·R·S — rotating a pre-squashed ellipse would wobble it instead of turning it. Hence the
//     nesting below: `shieldGlowFx` is a Container carrying the squash (scale.y = ry/rx), and its
//     children draw on a circle of radius rx and carry the rotation.
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

/** Dashes the ring is cut into, and how much of each slot is ink rather than gap. */
const DASH_COUNT = 16;
const DASH_FRAC = 0.5;
/** Ring radius as a multiple of the dome's — just outside the glass. */
const RING_R = 1.05;
const SPARK_COUNT = 4;
/** Angular speeds, rad/s. The sparkles counter-rotate so the two layers never lock together. */
const RING_SPIN = 0.6;
const SPARK_SPIN = -0.78;
/** Breathing pulse rate (rad/s) and the twinkle rate of an individual sparkle. */
const BREATHE_RATE = 1.3;
const TWINKLE_RATE = 2.2;

// Everything below is drawn at its BRIGHTEST; `animateShield` dips `alpha` to these floors for the
// trough of the breath. Splitting it that way is what lets a step be an alpha write instead of a
// redraw — see the header. The dome's stroke and fill breathed at slightly different ratios before
// (0.55→0.75 and 0.08→0.13); one shared alpha lands the fill at 0.095 rather than 0.08 at the
// trough, which is below the threshold where anyone could tell the two apart on paper texture.
const DOME_ALPHA_FLOOR = 0.73;
const RING_ALPHA_FLOOR = 0.62;
const SPARK_ALPHA_FLOOR = 0.43;
/** Sparkle radius at its dimmest, as a fraction of its brightest. */
const SPARK_SCALE_FLOOR = 0.6;

/** Child names inside a `shieldGlowFx` container. */
const RING_NAME = 'ring';
const SPARKS_NAME = 'sparks';

/**
 * Build the empty `shieldGlowFx` subtree — the squash container, its dashed ring and its sparkle
 * holder. Called once per city container (city.ts), alongside the two plain Graphics layers.
 *
 * Additive blend lives on the leaves, not here: `Container` has no `blendMode` (it is a property of
 * the drawable itself in PIXI), so each Graphics sets its own.
 */
export function createShieldGlow(): PIXI.Container {
  const root = new PIXI.Container();
  root.name = 'shieldGlowFx';
  const ring = new PIXI.Graphics();
  ring.name = RING_NAME;
  ring.blendMode = PIXI.BLEND_MODES.ADD;
  const sparks = new PIXI.Container();
  sparks.name = SPARKS_NAME;
  for (let i = 0; i < SPARK_COUNT; i++) {
    const spark = new PIXI.Graphics();
    spark.blendMode = PIXI.BLEND_MODES.ADD;
    sparks.addChild(spark);
  }
  root.addChild(ring);
  root.addChild(sparks);
  return root;
}

/** Dome: translucent fill + soft edge, drawn at peak brightness (the breath is `alpha`). Single
 *  drawEllipse call — the one authoritative "shield outline" draw (tests spy on this specifically).
 *  Normal blend mode (set once at creation, not here) — this is the "glass", not the "glow". */
export function drawShieldDome(g: PIXI.Graphics, geom: ShieldGeom): void {
  const { cx, cy, rx, ry, tp } = geom;
  g.clear();
  g.lineStyle(Math.max(1.5, tp * 0.02), 0x5fd4ff, 0.75);
  g.beginFill(0x5fd4ff, 0.13);
  g.drawEllipse(cx, cy, rx, ry);
  g.endFill();
}

/**
 * Rebuild the rotating ring + sparkle ticks just outside the dome — same hand-drawn dashed-boundary
 * motif as the territory outline (tileStyle.ts). Geometry only: every child draws on a CIRCLE of
 * radius `rx` and the container carries `scale.y = ry/rx`, so a child's `rotation` turns the shape
 * around the ellipse properly (see the header on T·R·S).
 *
 * Call whenever the layout changed (refreshCityLayer); the per-frame spin is `animateShield`.
 */
export function drawShieldGlow(root: PIXI.Container, geom: ShieldGeom): void {
  const { cx, cy, rx, ry, tp } = geom;
  root.position.set(cx, cy);
  root.scale.set(1, rx === 0 ? 1 : ry / rx);

  const ring = root.getChildByName(RING_NAME) as PIXI.Graphics;
  ring.clear();
  ring.lineStyle(Math.max(1, tp * 0.015), 0x8fe6ff, 0.8);
  for (let i = 0; i < DASH_COUNT; i++) {
    const a0 = (i / DASH_COUNT) * Math.PI * 2;
    const a1 = a0 + ((Math.PI * 2) / DASH_COUNT) * DASH_FRAC;
    ring.moveTo(Math.cos(a0) * rx * RING_R, Math.sin(a0) * rx * RING_R);
    ring.lineTo(Math.cos(a1) * rx * RING_R, Math.sin(a1) * rx * RING_R);
  }

  const sparks = root.getChildByName(SPARKS_NAME) as PIXI.Container;
  const sparkleR = Math.max(1.2, tp * 0.03);
  for (let i = 0; i < sparks.children.length; i++) {
    const spark = sparks.children[i] as PIXI.Graphics;
    const a = (i / SPARK_COUNT) * Math.PI * 2;
    spark.position.set(Math.cos(a) * rx, Math.sin(a) * rx);
    spark.clear();
    spark.beginFill(0xdff8ff, 0.7);
    spark.drawCircle(0, 0, sparkleR);
    spark.endFill();
  }
}

/** Blank a shield that is no longer up, without tearing the subtree down (the city container is
 *  pooled across refreshes and the same base may get protected again). */
export function clearShieldGlow(root: PIXI.Container): void {
  (root.getChildByName(RING_NAME) as PIXI.Graphics).clear();
  const sparks = root.getChildByName(SPARKS_NAME) as PIXI.Container;
  for (const spark of sparks.children) (spark as PIXI.Graphics).clear();
}

/**
 * One animation step for a single bubble: spin, breathe, twinkle. Transform and alpha writes only —
 * nothing here touches geometry, which is the whole point (see the header). `t` is elapsed seconds
 * on the map's own shield clock (WorldMapContext.shieldAnimT), not wall time, so it stays
 * deterministic/testable like the rest of this scene.
 */
export function animateShield(dome: PIXI.Graphics, root: PIXI.Container, t: number): void {
  const breathe = 0.5 + 0.5 * Math.sin(t * BREATHE_RATE);
  dome.alpha = DOME_ALPHA_FLOOR + (1 - DOME_ALPHA_FLOOR) * breathe;

  const ring = root.getChildByName(RING_NAME) as PIXI.Graphics;
  ring.rotation = t * RING_SPIN;
  ring.alpha = RING_ALPHA_FLOOR + (1 - RING_ALPHA_FLOOR) * breathe;

  const sparks = root.getChildByName(SPARKS_NAME) as PIXI.Container;
  sparks.rotation = t * SPARK_SPIN;
  for (let i = 0; i < sparks.children.length; i++) {
    const spark = sparks.children[i] as PIXI.Graphics;
    const tw = 0.5 + 0.5 * Math.sin(t * TWINKLE_RATE + i * 1.7);
    spark.alpha = SPARK_ALPHA_FLOOR + (1 - SPARK_ALPHA_FLOOR) * tw;
    const s = SPARK_SCALE_FLOOR + (1 - SPARK_SCALE_FLOOR) * tw;
    spark.scale.set(s, s);
  }
}

/** Seconds the one-shot "shield just broke" pop lasts — see WorldMapContext.shieldBreakFx. */
export const SHIELD_BREAK_LIFE = 0.4;

/** One-shot expanding/fading ring burst for the instant a base's protection lapses — borrowed
 *  from daydayup's `shield_break` flash (concentric rings, additive, ~170ms). Ours runs a bit
 *  longer (400ms) since the dome itself is bigger on-screen than a twin-stick character sprite.
 *  `age` is seconds since the break was first observed; caller removes the entry once it exceeds
 *  SHIELD_BREAK_LIFE. This one DOES redraw per frame — it lives 0.4 s, it changes radius rather
 *  than just angle, and it fires at most once per base per protection window. */
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
