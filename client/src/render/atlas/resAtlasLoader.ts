/**
 * resAtlasLoader.ts — SLG resource motif atlas loader.
 *
 * Five hand-drawn stationery motifs (ink / paper / graphite / metal / sticker),
 * each 128px on the long edge, packed into the shared worldAtlas (see that
 * module) as the `res_*` frames. Used by WorldMapScene.drawTileL1() to render
 * resource-tile abundance clusters.
 *
 * Loading is fire-and-forget (L1 lazy — called on WorldMapScene construction).
 * A decode failure does not block the map; tiles fall back to color-only rendering.
 * Motif lines are black hand-drawn and must NOT be tinted.
 */
import type * as PIXI from 'pixi.js-legacy';
import { worldAtlas as atlas } from './worldAtlas';

/** True once the atlas PNG has decoded and frames are parsed. */
export const isResAtlasReady = atlas.isReady;

/** Texture for a resource type's generic frame (e.g. `res_ink`), or null if not ready/unknown. */
export function getResTexture(resType: string): PIXI.Texture | null {
  return atlas.getTexture(`res_${resType}`);
}

/**
 * Texture for a resource type's exact-LEVEL frame (e.g. `res_ink_l7`), or null if that
 * specific level's art hasn't been produced yet. Unlike `getResTexture`, this has no
 * fallback — callers use the null to decide whether to fall back to the generic motif's
 * count/alpha simulation instead. Lets per-level art drop in resType-by-resType,
 * level-by-level with zero code change (mirrors cityAtlasLoader's getCityTextureForLevel).
 */
export function getResLevelTexture(resType: string, level: number): PIXI.Texture | null {
  if (!atlas.isReady()) return null;
  const lv = Math.max(1, Math.min(10, Math.round(level)));
  return atlas.getTexture(`res_${resType}_l${lv}`);
}

/**
 * Decode + parse the shared world atlas. Idempotent: concurrent / repeat calls
 * share one in-flight promise. Rejects on PNG decode error; callers may ignore
 * the result (motifs are optional ambience, color-only fallback always works).
 */
export const loadResAtlas = atlas.load;
