/**
 * wearOverlay.ts — the "notebook flipped through for a year" static overlay.
 *
 * Art direction §3.1 / §6.1: a single shared, full-screen wear layer — grain
 * speckles, a fold crease or two, faint corner darkening (vignette) and a marker
 * bleed-through blot. It is deterministic (seeded `Prng`) and baked once per
 * (w,h) so it costs nothing per frame; one instance is laid faintly over both
 * the lobby and the battle so the whole game shares the same worn page.
 *
 * Kept low-alpha and non-interactive — it is atmosphere, never an information
 * layer (the functional/HUD text always lives above it).
 */
import * as PIXI from 'pixi.js-legacy';
import { Prng } from '../game/math/prng';
import { palette } from './theme';
import { bake } from './bake';

function frand(p: Prng): number { return p.nextInt(0x100000) / 0x100000; }

/**
 * Build the wear overlay sized `w × h`. Returns a baked Sprite (cached per size)
 * or, headless, the live Graphics. Always non-interactive.
 */
export function buildWearOverlay(w: number, h: number): PIXI.DisplayObject {
  const gfx = new PIXI.Graphics();
  const p   = new Prng(0x7ea21 ^ ((Math.round(w) << 8) ^ Math.round(h)));

  // ── Grain: a fine scatter of faint graphite speckles. ──────────────────────
  const dots = Math.min(2600, Math.round((w * h) / 900));
  for (let i = 0; i < dots; i++) {
    const x = frand(p) * w;
    const y = frand(p) * h;
    const r = 0.4 + frand(p) * 0.9;
    gfx.beginFill(palette.pencil, 0.025 + frand(p) * 0.03);
    gfx.drawCircle(x, y, r);
    gfx.endFill();
  }

  // ── Fold creases: one or two long faint lines across the page. ─────────────
  const creases = 1 + (p.nextInt(2));
  for (let i = 0; i < creases; i++) {
    const vertical = frand(p) < 0.5;
    gfx.lineStyle(1.4, palette.paperDeep, 0.20);
    if (vertical) {
      const x = w * (0.2 + frand(p) * 0.6);
      gfx.moveTo(x, 0); gfx.lineTo(x + (frand(p) * 2 - 1) * 6, h);
    } else {
      const y = h * (0.2 + frand(p) * 0.6);
      gfx.moveTo(0, y); gfx.lineTo(w, y + (frand(p) * 2 - 1) * 6);
    }
    gfx.lineStyle(0);
  }

  // ── Corner darkening (vignette): nested low-alpha corner triangles, no gradient. ─
  const cs = Math.min(w, h) * 0.34;
  const corners: Array<[number, number, number, number]> = [
    [0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1],
  ];
  for (const [ox, oy, sx, sy] of corners) {
    for (let k = 0; k < 5; k++) {
      const d = cs * (1 - k / 5);
      gfx.beginFill(palette.paperDeep, 0.05);
      gfx.moveTo(ox, oy);
      gfx.lineTo(ox + sx * d, oy);
      gfx.lineTo(ox, oy + sy * d);
      gfx.closePath();
      gfx.endFill();
    }
  }

  // ── Marker bleed-through (ghost print): a couple of faint warm blots. ──────────────
  const blots = 2 + p.nextInt(2);
  for (let i = 0; i < blots; i++) {
    const x = frand(p) * w, y = frand(p) * h;
    const r = 14 + frand(p) * 26;
    gfx.beginFill(palette.marker, 0.035);
    gfx.drawCircle(x, y, r);
    gfx.endFill();
  }

  const tex = bake(`wear:${Math.round(w)}x${Math.round(h)}`, gfx, w, h);
  const node: PIXI.DisplayObject = tex ? new PIXI.Sprite(tex) : gfx;
  if (tex) gfx.destroy();
  node.eventMode = 'none';
  return node;
}
