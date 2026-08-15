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
 * The emblem icon, sized `size` x `size`, tinted in the given accent colour.
 * Returns null if the atlas has not finished loading — callers decide the
 * fallback (there is no procedural glyph for emblems, unlike faction totems).
 */
export function buildEmblemIcon(key: EmblemKey, size: number, tint: number): PIXI.Sprite | null {
  const tex = getEmblemIconTexture(key);
  if (!tex) return null;
  const sprite = new PIXI.Sprite(tex);
  sprite.anchor.set(0, 0);
  sprite.width = sprite.height = size;
  sprite.tint = tint;
  return sprite;
}
