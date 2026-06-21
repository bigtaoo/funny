/**
 * vfx/primitives.ts — draw implementations for each vector primitive.
 *
 * Every primitive draws in its own local origin (0,0); the instance's world
 * position is set by VFXSystem on the host Graphics. Numeric knobs are read
 * from layer.params and sampled at progress t. Randomness, where used, is
 * seeded (Prng) so playback/replay is deterministic (design §6).
 */
import * as PIXI from 'pixi.js-legacy';
import { Prng } from '../../game/math/prng';
import { LayerDef, ParamTrack } from './types';
import { sampleParam } from './sampleParam';

/** Read a layer param at progress t (constant or animated), with fallback. */
function p(layer: LayerDef, key: string, t: number, fallback = 0): number {
  const track: ParamTrack | undefined = layer.params?.[key];
  return sampleParam(track, t, fallback);
}

/** Deterministic float in [0,1) wrapping the game Prng (visual-only). */
function frand(prng: Prng): number {
  return prng.nextInt(0x1000000) / 0x1000000;
}

type DrawPrimitive = (
  gfx: PIXI.Graphics,
  layer: LayerDef,
  t: number,
  color: number,
  prng: Prng,
) => void;

const ring: DrawPrimitive = (gfx, layer, t, color) => {
  const radius    = p(layer, 'radius', t, 0);
  const alpha     = p(layer, 'alpha', t, 1);
  const lineWidth = p(layer, 'lineWidth', t, 2);
  if (radius <= 0 || alpha <= 0) return;
  gfx.lineStyle(lineWidth, color, alpha);
  gfx.drawCircle(0, 0, radius);
};

const arc: DrawPrimitive = (gfx, layer, t, color) => {
  const radius     = p(layer, 'radius', t, 0);
  const alpha      = p(layer, 'alpha', t, 1);
  const lineWidth  = p(layer, 'lineWidth', t, 2);
  const startAngle = p(layer, 'startAngle', t, 0);
  const sweep      = p(layer, 'sweep', t, Math.PI);
  if (radius <= 0 || alpha <= 0 || sweep === 0) return;
  gfx.lineStyle(lineWidth, color, alpha);
  gfx.arc(0, 0, radius, startAngle, startAngle + sweep, sweep < 0);
};

const spokes: DrawPrimitive = (gfx, layer, t, color) => {
  const count   = Math.max(1, layer.count ?? 1);
  const innerR  = p(layer, 'innerR', t, 0);
  const outerR  = p(layer, 'outerR', t, 0);
  const alpha   = p(layer, 'alpha', t, 1);
  const rotation = p(layer, 'rotation', t, 0);
  const lineWidth = p(layer, 'lineWidth', t, 2);
  // Optional manga emphasis: every Nth spoke uses emphasisLineWidth.
  const emphasisEvery = p(layer, 'emphasisEvery', t, 0);
  const emphasisLineWidth = p(layer, 'emphasisLineWidth', t, lineWidth);
  if (alpha <= 0) return;
  for (let i = 0; i < count; i++) {
    const ang = rotation + (i / count) * Math.PI * 2;
    const w = emphasisEvery >= 1 && i % Math.round(emphasisEvery) === 0
      ? emphasisLineWidth : lineWidth;
    gfx.lineStyle(w, color, alpha);
    gfx.moveTo(Math.cos(ang) * innerR, Math.sin(ang) * innerR);
    gfx.lineTo(Math.cos(ang) * outerR, Math.sin(ang) * outerR);
  }
};

const burst: DrawPrimitive = (gfx, layer, t, color) => {
  const count    = Math.max(1, layer.count ?? 1);
  const nearR    = p(layer, 'nearR', t, 0);
  const farR     = p(layer, 'farR', t, 0);
  const alpha    = p(layer, 'alpha', t, 1);
  const rotation = p(layer, 'rotation', t, 0);
  const lineWidth = p(layer, 'lineWidth', t, 2);
  if (alpha <= 0) return;
  gfx.lineStyle(lineWidth, color, alpha);
  for (let i = 0; i < count; i++) {
    const ang = rotation + (i / count) * Math.PI * 2;
    gfx.moveTo(Math.cos(ang) * nearR, Math.sin(ang) * nearR);
    gfx.lineTo(Math.cos(ang) * farR, Math.sin(ang) * farR);
  }
};

const dots: DrawPrimitive = (gfx, layer, t, color, prng) => {
  const count       = Math.max(1, layer.count ?? 1);
  const spreadR     = p(layer, 'spreadR', t, 0);
  const dotSize     = p(layer, 'dotSize', t, 2);
  const alpha       = p(layer, 'alpha', t, 1);
  const angleOffset = p(layer, 'angleOffset', t, 0);
  const jitter      = p(layer, 'jitter', t, 0); // seeded radial/angular noise amplitude
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
    gfx.drawCircle(Math.cos(ang) * r, Math.sin(ang) * r, dotSize);
  }
  gfx.endFill();
};

const polyline: DrawPrimitive = (gfx, layer, t, color) => {
  const pts = layer.points;
  if (!pts || pts.length < 2) return;
  const alpha     = p(layer, 'alpha', t, 1);
  const lineWidth = p(layer, 'lineWidth', t, 2);
  const scale     = p(layer, 'scale', t, 1);
  const rotation  = p(layer, 'rotation', t, 0);
  const tx        = p(layer, 'translateX', t, 0);
  const ty        = p(layer, 'translateY', t, 0);
  if (alpha <= 0) return;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const xf = (px: number, py: number): [number, number] => {
    const sx = px * scale, sy = py * scale;
    return [sx * cos - sy * sin + tx, sx * sin + sy * cos + ty];
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

/**
 * `text` is drawn via VFXSystem (needs a PIXI.Text child, not Graphics).
 * Stubbed here so the registry is total; interpret routes text specially.
 */
const text: DrawPrimitive = () => { /* handled by interpret/VFXSystem */ };

export const PRIMITIVES: Readonly<Record<string, DrawPrimitive>> = {
  ring, arc, spokes, burst, dots, polyline, text, emitter,
};
