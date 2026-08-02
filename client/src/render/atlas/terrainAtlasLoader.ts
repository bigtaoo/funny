/**
 * terrainAtlasLoader.ts — SLG map terrain ground tile atlas loader.
 *
 * Six hand-drawn ground textures (grass / mountain / river / keep / center /
 * stronghold), each 256px square, packed into the shared worldAtlas (see that
 * module) as the `terrain_*` frames. Used by WorldMapScene.drawTileL1() to
 * replace the flat-color terrain fill with a sprite texture, clipped into the
 * diamond tile shape at render time.
 *
 * Loading is fire-and-forget (L1 lazy — called on WorldMapScene construction).
 * A decode failure does not block the map; tiles fall back to the existing flat-color
 * `beginFill` rendering. Tile lines are black hand-drawn and must NOT be tinted;
 * ownership wash / level dot / fog / etc. continue to be drawn on top.
 */
import type * as PIXI from 'pixi.js-legacy';
import { worldAtlas as atlas } from './worldAtlas';

export type TerrainTextureName =
  | 'terrain_grass'
  | 'terrain_mountain'
  | 'terrain_river'
  | 'terrain_keep'
  | 'terrain_center'
  | 'terrain_stronghold';

/** True once the atlas PNG has decoded and frames are parsed. */
export const isTerrainAtlasReady = atlas.isReady;

/** Texture for a terrain frame (e.g. `terrain_grass`), or null if not ready/unknown. */
export const getTerrainTexture = atlas.getTexture as (name: TerrainTextureName) => PIXI.Texture | null;

/**
 * Decode + parse the shared world atlas. Idempotent: concurrent / repeat calls
 * share one in-flight promise. Rejects on PNG decode error; callers may ignore
 * the result (tiles fall back to the flat-color fill).
 */
export const loadTerrainAtlas = atlas.load;
