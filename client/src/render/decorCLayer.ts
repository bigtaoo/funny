/**
 * decorCLayer.ts — C-group UI large background decoration layer (art-direction §6.2 C-group).
 *
 * Scatters C-group hand-drawn assets (castle / catapult / paper-plane / ink blot …) at very
 * low alpha randomly across the paper background of UI scenes (lobby / menus etc.), creating a
 * "notebook-margin doodle" atmosphere.
 *
 * Design constraints (same as A-group decorLayer.ts):
 * - Original ink colour, no tint; faint alpha (0.06–0.15) never competes with foreground
 * - Deterministic PRNG (fixed seed) — identical layout on every build
 * - Statically baked (`bake()`), zero runtime cost; falls back to live Graphics in headless mode
 * - interactiveChildren = false — does not consume pointer events
 */
import * as PIXI from 'pixi.js-legacy';
import { Prng } from '../game/math/prng';
import { bake } from './bake';
import { decorCFrameNames, getDecorCTexture, isDecorCReady } from './decorCAtlas';

// ── Tuning ────────────────────────────────────────────────────────────────────
const SIZE_PX       = 96;    // target rendered size (px); C-group source frames are 128px, scaled slightly down
const SIZE_JITTER   = 0.25;  // ± fraction of SIZE_PX
const GRID_COLS     = 6;     // divide width into N columns for placement grid
const GRID_ROWS     = 9;     // divide height into N rows
// Dense at edges, sparse at centre: the main UI content (hero / pillar) occupies the central
// vertical band, so placing doodles there wastes them behind panels and paradoxically makes the
// scene feel "under-decorated". Push doodles to the surrounding border region (notebook margin
// doodles belong at the edges anyway).
const EDGE_SKIP     = 0.20;  // edge columns / top+bottom rows — denser frame
const CENTER_SKIP   = 0.80;  // interior cells behind content — kept sparse
const ROT_MAX       = 0.45;  // ± radians; more relaxed than A-group edge doodles
const ALPHA_MIN     = 0.25;  // random alpha 0.25–0.38
const ALPHA_RANGE   = 0.13;
const SEED          = 0xC09C_0FFE;  // "c coffee" — stable across UI redraws

function frand(p: Prng): number { return p.nextInt(1_000_000) / 1_000_000; }

/**
 * Build a static background scatter of C-group doodles covering `(w × h)`.
 * Returns null if the atlas is not yet loaded or no frames are available
 * (caller simply skips — decorations are optional ambience).
 * The returned Container holds one baked-texture Sprite and costs nothing
 * per frame; add it directly behind the UI content layer.
 */
export function buildDecorCLayer(w: number, h: number): PIXI.Container | null {
  if (!isDecorCReady()) return null;
  const frames = decorCFrameNames();
  if (frames.length === 0) return null;

  const prng = new Prng(SEED);
  const cellW = w / GRID_COLS;
  const cellH = h / GRID_ROWS;

  const content = new PIXI.Container();
  let placed = 0;

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const edge = col === 0 || col === GRID_COLS - 1 || row === 0 || row === GRID_ROWS - 1;
      if (frand(prng) < (edge ? EDGE_SKIP : CENTER_SKIP)) continue;

      const name = frames[prng.nextInt(frames.length)]!;
      const tex = getDecorCTexture(name);
      if (!tex) continue;

      const spr = new PIXI.Sprite(tex);
      spr.anchor.set(0.5);

      const sizeMul = 1 + (frand(prng) * 2 - 1) * SIZE_JITTER;
      const longest = Math.max(tex.width, tex.height) || SIZE_PX;
      spr.scale.set((SIZE_PX * sizeMul) / longest);
      spr.rotation = (frand(prng) * 2 - 1) * ROT_MAX;
      spr.alpha = ALPHA_MIN + frand(prng) * ALPHA_RANGE;

      // Random position within the cell, keeping the sprite fully inside (w × h).
      const halfW = (tex.width  * spr.scale.x) / 2;
      const halfH = (tex.height * spr.scale.y) / 2;
      const cellX = col * cellW;
      const cellY = row * cellH;
      const safeX0 = Math.max(halfW, cellX + halfW);
      const safeX1 = Math.min(w - halfW, cellX + cellW - halfW);
      const safeY0 = Math.max(halfH, cellY + halfH);
      const safeY1 = Math.min(h - halfH, cellY + cellH - halfH);
      spr.x = safeX0 + frand(prng) * Math.max(0, safeX1 - safeX0);
      spr.y = safeY0 + frand(prng) * Math.max(0, safeY1 - safeY0);

      content.addChild(spr);
      placed++;
    }
  }

  if (placed === 0) { content.destroy(); return null; }

  const root = new PIXI.Container();
  root.interactiveChildren = false;

  const tex = bake(`decorc:${Math.round(w)}x${Math.round(h)}`, content, w, h);
  content.destroy({ children: true });
  if (tex) {
    root.addChild(new PIXI.Sprite(tex));
  }
  // If bake fails (headless) we simply return an empty container — acceptable.

  return root;
}
