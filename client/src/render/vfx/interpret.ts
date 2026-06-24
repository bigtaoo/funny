/**
 * vfx/interpret.ts — draw one frame of a data-driven effect.
 *
 * Single source of truth for "given layers + progress t, paint this Graphics".
 * Consumed by VFXSystem (runtime) and the vfx-editor (preview).
 */
import * as PIXI from 'pixi.js-legacy';
import { Prng } from '../../game/math/prng';
import { LayerDef } from './types';
import { PRIMITIVES } from './primitives';

/** Cheap stable seed for a layer when it declares no explicit seed. */
function layerSeed(layer: LayerDef, baseSeed: number, index: number): number {
  return (layer.seed ?? (Math.imul(baseSeed, 31) + index + 1)) >>> 0 || 1;
}

/**
 * Render all layers of an effect at progress t into a pre-cleared Graphics.
 * @param layers    effect.layers
 * @param t         progress 0 → 1 (caller clamps)
 * @param gfx       target, already positioned and cleared by the caller
 * @param color     resolved primary colour (hex number)
 * @param baseSeed  per-instance seed base (effect id hash), default 1
 */
export function interpret(
  layers: readonly LayerDef[],
  t: number,
  gfx: PIXI.Graphics,
  color: number,
  baseSeed = 1,
): void {
  // Draw order = z ascending, falling back to array index (decision: z editable,
  // default = array order). Seed stays tied to the ORIGINAL index for stability.
  const order = layers.map((_, i) => i).sort((a, b) => {
    const za = layers[a].z ?? a;
    const zb = layers[b].z ?? b;
    return za - zb || a - b;
  });
  for (const i of order) {
    const layer = layers[i];
    const draw = PRIMITIVES[layer.type];
    if (!draw) {
      console.warn(`VFX: unknown primitive "${layer.type}" — layer skipped.`);
      continue;
    }
    // Re-seed per frame with the same seed → identical jitter each frame
    // (no flicker within an instance). baseSeed varies per instance (random by
    // default) or is fixed when the caller passes a seed (replay-stable).
    const prng = new Prng(layerSeed(layer, baseSeed, i));
    draw(gfx, layer, t, color, prng);
  }
}
