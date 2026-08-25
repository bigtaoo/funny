/**
 * emblemIcon.ts — family/sect emblem icon lookup (design/product/family-emblem-art-prompts.md).
 *
 * The 24-design fixed pool a family/sect will eventually pick one of (guild
 * badge on the world map's march tokens, per WORLD_MAP_ART_SPEC.md §五's
 * `MARCH_TOKEN_ASSET` TODO). Art is white line-on-transparent (emblemAtlas.ts),
 * meant to be `tint`ed to whatever accent colour the family/sect chose — same
 * contract as `buildFactionIcon` (render/factionIcon.ts).
 *
 * No consumer yet: there is no `emblemKey` field on the family/sect document
 * and no picker UI (tracked in family-emblem-art-prompts.md's closing TODO
 * list). This module only exposes the lookup so that UI can be built against
 * a stable API once it lands — it is deliberately NOT wired into bootManifest
 * L0 (see emblemAtlas.ts).
 */
import * as PIXI from 'pixi.js-legacy';
import { EMBLEM_KEYS, EMBLEM_COLORS, type EmblemKey } from '@nw/shared';
import { emblemAtlas as atlas } from './atlas/emblemAtlas';

/** The 24 fixed-pool emblem keys, in the same order as the source art / atlas grid (canonical
 *  copy lives in @nw/shared so the server can validate the same set — see EMBLEM_KEYS there). */
export { EMBLEM_KEYS, EMBLEM_COLORS };
export type { EmblemKey };

/** True once the atlas PNG has decoded and frames are parsed. */
export const isEmblemAtlasReady = atlas.isReady;

/** Decode + parse the atlas. Idempotent; rejects on decode error. Call on scene entry (NOT boot — see emblemAtlas.ts). */
export const loadEmblemAtlas = atlas.load;

/** Texture for an emblem key from the atlas, or null until it is loaded. */
export function getEmblemIconTexture(key: EmblemKey): PIXI.Texture | null {
  return atlas.getTexture(key);
}

/**
 * Below this size (design px) the fine multi-stroke line art fades into the paper background
 * before it reads at all — the same "crisp at ≥48px, faint at ≤20px" ceiling `factionIcon.ts`
 * documents for the sibling white-line-art contract. Every small/dense consumer (header badges,
 * roster rows, ProfilePopup, the world-map corner badge) sits well under that ceiling, which is
 * exactly why a picked family/sect badge read as "几乎不可见" in the top bar (2026-08-25 report):
 * a faintly-tinted line on cream paper, however carefully coloured, is nothing at ~35px.
 */
const BADGE_MEDALLION_MAX = 44;

/** Fixed ink tone for the small-size medallion's ring, independent of the accent colour picked —
 *  reads as the same hand-drawn-outline weight as every other bordered shape in this art style,
 *  whichever of the 8 EMBLEM_COLORS swatches is in play. */
const MEDALLION_RING = 0x2f2a26;

/**
 * The emblem icon, sized `size` x `size`. At `size` ≥ {@link BADGE_MEDALLION_MAX} (roomy contexts —
 * the picker grid, a detail-view preview) this is the plain accent-tinted line-art sprite. Below
 * that, the tinted line art itself would be illegible (see the constant's note), so instead this
 * flips the contrast: a solid accent-colour disc with the (un-tinted, still-white) line art knocked
 * out on top — a coin, not a wash — so there is always a strong colour shape to read, with whatever
 * of the icon's silhouette survives at that size as a bonus. Returns null if the atlas has not
 * finished loading — callers decide the fallback (there is no procedural glyph for emblems, unlike
 * faction totems).
 */
export function buildEmblemIcon(key: EmblemKey, size: number, tint: number): PIXI.DisplayObject | null {
  const tex = getEmblemIconTexture(key);
  if (!tex) return null;
  if (size < BADGE_MEDALLION_MAX) {
    const badge = new PIXI.Container();
    const disc = new PIXI.Graphics();
    disc.lineStyle(Math.max(1, size * 0.06), MEDALLION_RING, 0.55);
    disc.beginFill(tint, 1);
    disc.drawCircle(size / 2, size / 2, size / 2 - 1);
    disc.endFill();
    badge.addChild(disc);
    const pad = size * 0.18;
    const sprite = new PIXI.Sprite(tex);
    sprite.anchor.set(0, 0);
    sprite.x = pad; sprite.y = pad;
    sprite.width = sprite.height = size - pad * 2;
    // No tint here on purpose — white line art knocked out of the solid disc, not a faint colour
    // line on paper (that faintness is the whole problem this branch exists to fix).
    badge.addChild(sprite);
    return badge;
  }
  const sprite = new PIXI.Sprite(tex);
  sprite.anchor.set(0, 0);
  sprite.width = sprite.height = size;
  sprite.tint = tint;
  return sprite;
}
