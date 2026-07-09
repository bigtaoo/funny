/**
 * terrainAtlasLoader.ts — SLG map terrain ground tile atlas loader.
 *
 * Six hand-drawn ground textures (grass / mountain / river / keep / center /
 * stronghold), each 256px square, packed into `assets/slg/terrain_atlas.{png,json}`.
 * Used by WorldMapScene.drawTileL1() to replace the flat-color terrain fill with a
 * sprite texture, clipped into the diamond tile shape at render time.
 *
 * Loading is fire-and-forget (L1 lazy — called on WorldMapScene construction).
 * A decode failure does not block the map; tiles fall back to the existing flat-color
 * `beginFill` rendering. Tile lines are black hand-drawn and must NOT be tinted;
 * ownership wash / level dot / fog / etc. continue to be drawn on top.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/slg/terrain_atlas.png';
import atlasData from '../assets/slg/terrain_atlas.json';

export type TerrainTextureName =
  | 'terrain_grass'
  | 'terrain_mountain'
  | 'terrain_river'
  | 'terrain_keep'
  | 'terrain_center'
  | 'terrain_stronghold';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the atlas PNG has decoded and frames are parsed. */
export function isTerrainAtlasReady(): boolean {
  return sheet !== null;
}

/** Texture for a terrain frame (e.g. `terrain_grass`), or null if not ready/unknown. */
export function getTerrainTexture(name: TerrainTextureName): PIXI.Texture | null {
  return sheet ? (sheet.textures[name] ?? null) : null;
}

/**
 * Decode + parse the terrain tile atlas. Idempotent: concurrent / repeat calls
 * share one in-flight promise. Rejects on PNG decode error; callers may ignore
 * the result (tiles fall back to the flat-color fill).
 */
export async function loadTerrainAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string));
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) => reject(new Error(`terrain atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}
