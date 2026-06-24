/**
 * vfx/primitives.ts — draw implementations for each vector primitive.
 *
 * Every primitive draws in its own local origin (0,0); the instance's world
 * position is set by VFXSystem on the host Graphics. Numeric knobs are read
 * from layer.params and sampled at progress t. Randomness, where used, is
 * seeded (Prng) so playback/replay is deterministic (design §6).
 *
 * Boil (design §6, P3): when a layer carries `boil`, the interpreter folds the
 * current boil-variant into the Prng seed (so the wobble pattern changes at the
 * boil fps, not every frame). Each primitive then nudges its vertices by a small
 * seeded amount (`boilAmp`, default 1.5px) — the classic hand-drawn "boiling
 * line" look. With no boil, amp is 0 and geometry is drawn exactly (the existing
 * 4 effects are byte-for-byte unchanged).
 */
import * as PIXI from 'pixi.js-legacy';
import { Prng } from '../../game/math/prng';
import { LayerDef, ParamTrack } from './types';
import { sampleParam } from './sampleParam';

const DEFAULT_BOIL_AMP = 1.5;

/** Read a layer param at progress t (constant or animated), with fallback. */
function p(layer: LayerDef, key: string, t: number, fallback = 0): number {
  const track: ParamTrack | undefined = layer.params?.[key];
  return sampleParam(track, t, fallback);
}

/** Deterministic float in [0,1) wrapping the game Prng (visual-only). */
function frand(prng: Prng): number {
  return prng.nextInt(0x1000000) / 0x1000000;
}

/** Boil wobble amplitude for this layer (0 when the layer doesn't boil). */
function boilAmp(layer: LayerDef, t: number): number {
  if (!layer.boil) return 0;
  return p(layer, 'boilAmp', t, DEFAULT_BOIL_AMP);
}

/** One seeded offset in [-amp, amp]; 0 (and no prng draw) when amp ≤ 0. */
function wob(prng: Prng, amp: number): number {
  return amp > 0 ? (frand(prng) * 2 - 1) * amp : 0;
}

/** Stroke a circle as a closed wobbly polygon (segment radii jittered once). */
function strokeBoilCircle(gfx: PIXI.Graphics, r: number, prng: Prng, amp: number): void {
  const segs = Math.max(16, Math.min(48, Math.round(r / 3)));
  const radii: number[] = [];
  for (let i = 0; i < segs; i++) radii.push(r + wob(prng, amp));
  for (let i = 0; i <= segs; i++) {
    const a = ((i % segs) / segs) * Math.PI * 2;
    const rr = radii[i % segs];           // i===segs reuses radii[0] → loop closes exactly
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) gfx.moveTo(x, y); else gfx.lineTo(x, y);
  }
}

/** Stroke an open arc as a wobbly polyline (per-vertex radius jitter). */
function strokeBoilArc(
  gfx: PIXI.Graphics, r: number, start: number, sweep: number, prng: Prng, amp: number,
): void {
  const segs = Math.max(4, Math.min(48, Math.round((Math.abs(sweep) / (Math.PI * 2)) * 48)));
  for (let i = 0; i <= segs; i++) {
    const a = start + sweep * (i / segs);
    const rr = r + wob(prng, amp);
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) gfx.moveTo(x, y); else gfx.lineTo(x, y);
  }
}

type DrawPrimitive = (
  gfx: PIXI.Graphics,
  layer: LayerDef,
  t: number,
  color: number,
  prng: Prng,
) => void;

const ring: DrawPrimitive = (gfx, layer, t, color, prng) => {
  const radius    = p(layer, 'radius', t, 0);
  const alpha     = p(layer, 'alpha', t, 1);
  const lineWidth = p(layer, 'lineWidth', t, 2);
  if (radius <= 0 || alpha <= 0) return;
  gfx.lineStyle(lineWidth, color, alpha);
  const amp = boilAmp(layer, t);
  if (amp > 0) strokeBoilCircle(gfx, radius, prng, amp);
  else gfx.drawCircle(0, 0, radius);
};

const arc: DrawPrimitive = (gfx, layer, t, color, prng) => {
  const radius     = p(layer, 'radius', t, 0);
  const alpha      = p(layer, 'alpha', t, 1);
  const lineWidth  = p(layer, 'lineWidth', t, 2);
  const startAngle = p(layer, 'startAngle', t, 0);
  const sweep      = p(layer, 'sweep', t, Math.PI);
  if (radius <= 0 || alpha <= 0 || sweep === 0) return;
  gfx.lineStyle(lineWidth, color, alpha);
  const amp = boilAmp(layer, t);
  if (amp > 0) strokeBoilArc(gfx, radius, startAngle, sweep, prng, amp);
  else gfx.arc(0, 0, radius, startAngle, startAngle + sweep, sweep < 0);
};

const spokes: DrawPrimitive = (gfx, layer, t, color, prng) => {
  const count   = Math.max(1, layer.count ?? 1);
  const innerR  = p(layer, 'innerR', t, 0);
  const outerR  = p(layer, 'outerR', t, 0);
  const alpha   = p(layer, 'alpha', t, 1);
  const rotation = p(layer, 'rotation', t, 0);
  const lineWidth = p(layer, 'lineWidth', t, 2);
  // Optional manga emphasis: every Nth spoke uses emphasisLineWidth.
  const emphasisEvery = p(layer, 'emphasisEvery', t, 0);
  const emphasisLineWidth = p(layer, 'emphasisLineWidth', t, lineWidth);
  const amp = boilAmp(layer, t);
  if (alpha <= 0) return;
  for (let i = 0; i < count; i++) {
    const ang = rotation + (i / count) * Math.PI * 2;
    const w = emphasisEvery >= 1 && i % Math.round(emphasisEvery) === 0
      ? emphasisLineWidth : lineWidth;
    gfx.lineStyle(w, color, alpha);
    gfx.moveTo(Math.cos(ang) * innerR + wob(prng, amp), Math.sin(ang) * innerR + wob(prng, amp));
    gfx.lineTo(Math.cos(ang) * outerR + wob(prng, amp), Math.sin(ang) * outerR + wob(prng, amp));
  }
};

const burst: DrawPrimitive = (gfx, layer, t, color, prng) => {
  const count    = Math.max(1, layer.count ?? 1);
  const nearR    = p(layer, 'nearR', t, 0);
  const farR     = p(layer, 'farR', t, 0);
  const alpha    = p(layer, 'alpha', t, 1);
  const rotation = p(layer, 'rotation', t, 0);
  const lineWidth = p(layer, 'lineWidth', t, 2);
  const amp = boilAmp(layer, t);
  if (alpha <= 0) return;
  gfx.lineStyle(lineWidth, color, alpha);
  for (let i = 0; i < count; i++) {
    const ang = rotation + (i / count) * Math.PI * 2;
    gfx.moveTo(Math.cos(ang) * nearR + wob(prng, amp), Math.sin(ang) * nearR + wob(prng, amp));
    gfx.lineTo(Math.cos(ang) * farR + wob(prng, amp), Math.sin(ang) * farR + wob(prng, amp));
  }
};

const dots: DrawPrimitive = (gfx, layer, t, color, prng) => {
  const count       = Math.max(1, layer.count ?? 1);
  const spreadR     = p(layer, 'spreadR', t, 0);
  const dotSize     = p(layer, 'dotSize', t, 2);
  const alpha       = p(layer, 'alpha', t, 1);
  const angleOffset = p(layer, 'angleOffset', t, 0);
  const jitter      = p(layer, 'jitter', t, 0); // seeded radial/angular noise amplitude
  const amp         = boilAmp(layer, t);
  if (dotSize <= 0 || alpha <= 0) return;
  gfx.lineStyle(0);
  gfx.beginFill(color, alpha);
  for (let i = 0; i < count; i++) {
    let ang = angleOffset + (i / count) * Math.PI * 2;
    let r = spreadR;
    if (jitter > 0) {
      ang += (frand(prng) - 0.5) * jitter;
      r += (frand(prng) - 0.5) * jitter * spreadR;
    }
    gfx.drawCircle(Math.cos(ang) * r + wob(prng, amp), Math.sin(ang) * r + wob(prng, amp), dotSize);
  }
  gfx.endFill();
};

const polyline: DrawPrimitive = (gfx, layer, t, color, prng) => {
  const pts = layer.points;
  if (!pts || pts.length < 2) return;
  const alpha     = p(layer, 'alpha', t, 1);
  const lineWidth = p(layer, 'lineWidth', t, 2);
  const scale     = p(layer, 'scale', t, 1);
  const rotation  = p(layer, 'rotation', t, 0);
  const tx        = p(layer, 'translateX', t, 0);
  const ty        = p(layer, 'translateY', t, 0);
  const amp       = boilAmp(layer, t);
  if (alpha <= 0) return;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const xf = (px: number, py: number): [number, number] => {
    const sx = px * scale, sy = py * scale;
    return [sx * cos - sy * sin + tx + wob(prng, amp), sx * sin + sy * cos + ty + wob(prng, amp)];
  };
  gfx.lineStyle(lineWidth, color, alpha);
  const [x0, y0] = xf(pts[0][0], pts[0][1]);
  gfx.moveTo(x0, y0);
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = xf(pts[i][0], pts[i][1]);
    gfx.lineTo(x, y);
  }
};

let warnedEmitter = false;

const emitter: DrawPrimitive = () => {
  if (!warnedEmitter) {
    console.warn('VFX: "emitter" primitive is reserved (§9) and not implemented; layer skipped.');
    warnedEmitter = true;
  }
};

export const PRIMITIVES: Readonly<Record<string, DrawPrimitive>> = {
  ring, arc, spokes, burst, dots, polyline, emitter,
};
