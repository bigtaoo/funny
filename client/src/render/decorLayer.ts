/**
 * decorLayer.ts — the battlefield doodle layer (art-direction §6.2).
 *
 * Snaps discrete hand-drawn doodles (from `decorAtlas`) onto the paper margins
 * just OUTSIDE the grid — the thin strips left/right of the board, between the
 * top and bottom HUD. Doodles never enter the battle area, never cover a base,
 * and (by deriving their bands from `boardRect`, which sits below the top HUD
 * and above the bottom HUD/hand) never overlap HUD. They are pure ambience
 * ("错位无妨，纯氛围").
 *
 * Each band's doodles are baked into one static texture (via `bake`, reusing the
 * shared cache) so the layer costs nothing per frame — like the ruled board
 * itself. Layout is deterministic (fixed seed per orientation+side), so a given
 * orientation always scrawls the same margin; like the baked grid it is stable
 * across battles rather than re-rolled each game (a per-battle reroll would mean
 * an unbounded set of cached margin textures — not worth it for edge ambience).
 *
 * Lines are the original ink colour and are NOT tinted (§6.2 注).
 */
import * as PIXI from 'pixi.js-legacy';
import { ILayout, Rect } from '../layout/ILayout';
import { Prng } from '../game/math/prng';
import { bake } from './bake';
import { decorFrameNames, getDecorTexture, isDecorReady } from './decorAtlas';

// ── Tuning (restrained — marginalia, not wallpaper) ──────────────────────────
const MIN_BAND_W   = 24;    // narrower strips aren't worth decorating
const SIZE_FRAC    = 0.72;  // doodle longest side ≈ this × band width …
const SIZE_MAX     = 64;    // … but never larger than the source frame
const SIZE_MIN     = 16;
const SPACING_FRAC = 3.4;   // slot pitch along the band = this × doodle size
const SKIP_PROB    = 0.45;  // chance a slot stays empty → sparse scatter
const ROT_MAX      = 0.22;  // ± radians of careless tilt
const SCALE_JITTER = 0.30;  // ± fraction of base scale
const ALPHA_MIN    = 0.40;  // faint so it never competes with the play area
const ALPHA_RANGE  = 0.22;
const SEED_BASE    = 0xD3C0DE;  // "decode" — fixed so the margin is stable

interface Band { side: 'left' | 'right'; rect: Rect; }

function frand(p: Prng): number { return p.nextInt(1_000_000) / 1_000_000; }

/** The two paper strips flanking the grid, within the board's vertical extent. */
function marginBands(layout: ILayout): Band[] {
  const r = layout.boardRect;
  const bands: Band[] = [
    { side: 'left',  rect: { x: 0, y: r.y, w: r.x, h: r.h } },
    { side: 'right', rect: { x: r.x + r.w, y: r.y, w: layout.designWidth - (r.x + r.w), h: r.h } },
  ];
  return bands.filter(b => b.rect.w >= MIN_BAND_W);
}

/**
 * Build the static decoration container for this layout, or null if there is
 * nothing to draw (atlas not loaded yet, or no usable margin). Caller adds the
 * returned container to the scene; it owns baked sprites only.
 */
export function buildDecorLayer(layout: ILayout): PIXI.Container | null {
  if (!isDecorReady()) return null;
  const frames = decorFrameNames();
  if (frames.length === 0) return null;

  const bands = marginBands(layout);
  if (bands.length === 0) return null;

  const root = new PIXI.Container();
  let drew = false;

  for (const band of bands) {
    const { rect } = band;
    const size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, rect.w * SIZE_FRAC));
    const pitch = size * SPACING_FRAC;
    const slots = Math.floor(rect.h / pitch);
    if (slots <= 0) continue;

    // Deterministic per orientation+side so the margin never shifts between
    // battles (and the baked texture cache key below is stable for it).
    const seed = (SEED_BASE ^ (band.side === 'left' ? 0x11 : 0x22)
      ^ (layout.orientation === 'portrait' ? 0x100 : 0x200)) >>> 0;
    const prng = new Prng(seed);

    // Doodles drawn in band-LOCAL coords (origin 0,0), then baked to a band-size
    // texture and placed at the band origin.
    const content = new PIXI.Container();
    let placed = 0;
    for (let i = 0; i < slots; i++) {
      if (frand(prng) < SKIP_PROB) continue;
      const name = frames[prng.nextInt(frames.length)]!;
      const tex = getDecorTexture(name);
      if (!tex) continue;

      const spr = new PIXI.Sprite(tex);
      spr.anchor.set(0.5);
      // Scale longest source side → `size`, with a little per-doodle variation.
      const longest = Math.max(tex.width, tex.height) || size;
      const scale = (size / longest) * (1 + (frand(prng) * 2 - 1) * SCALE_JITTER);
      spr.scale.set(scale);
      spr.rotation = (frand(prng) * 2 - 1) * ROT_MAX;
      spr.alpha = ALPHA_MIN + frand(prng) * ALPHA_RANGE;

      // Centre across the strip (small horizontal wiggle, kept fully inside it),
      // stepped down the strip with vertical jitter inside the slot.
      const half = size / 2;
      const wiggle = Math.max(0, rect.w - size);
      spr.x = half + frand(prng) * wiggle;
      const slotTop = i * pitch;
      spr.y = slotTop + half + frand(prng) * Math.max(0, pitch - size);
      content.addChild(spr);
      placed++;
    }
    if (placed === 0) { content.destroy({ children: true }); continue; }

    const key = `decor:${layout.orientation}:${band.side}:${Math.round(rect.w)}x${Math.round(rect.h)}:${layout.cellSize}`;
    const tex = bake(key, content, rect.w, rect.h);
    if (tex) {
      const sprite = new PIXI.Sprite(tex);
      sprite.position.set(rect.x, rect.y);
      root.addChild(sprite);
      content.destroy({ children: true });
    } else {
      // No renderer (headless): draw the doodles live at the band offset.
      content.position.set(rect.x, rect.y);
      root.addChild(content);
    }
    drew = true;
  }

  if (!drew) { root.destroy({ children: true }); return null; }
  root.interactiveChildren = false;  // pure ambience — never eats pointer events
  return root;
}
