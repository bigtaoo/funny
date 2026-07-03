/**
 * buildingAtlasLoader.ts — SLG map overlay-building atlas loader.
 *
 * Three hand-drawn structures that stand centered ON a map tile (distinct from the
 * ground-texture terrain atlas), packed into `assets/slg/building_atlas.{png,json}`:
 *   building_keep       — strategic chokepoint gatehouse (tile type `familyKeep`)
 *   building_stronghold — dark NPC fort (tile type `stronghold`)
 *   icon_watchtower     — player-built lookout (tile.watchtower)
 *
 * Loading is fire-and-forget (called on WorldMapScene construction). A decode failure
 * does not block the map: keep/stronghold still show their terrain ground texture, and
 * the watchtower falls back to the programmatic geometric marker. Ink lines are neutral
 * and must NOT be tinted (ownership/level are conveyed by the tile wash underneath).
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/slg/building_atlas.png';
import atlasData from '../assets/slg/building_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the atlas PNG has decoded and frames are parsed. */
export function isBuildingAtlasReady(): boolean {
  return sheet !== null;
}

/** Texture for a building frame (`building_keep` | `building_stronghold` | `icon_watchtower`), or null. */
export function getBuildingTexture(name: string): PIXI.Texture | null {
  return sheet ? (sheet.textures[name] ?? null) : null;
}

/**
 * Decode + parse the building atlas. Idempotent; concurrent calls share one in-flight
 * promise. Failure is non-fatal — see the module header for per-frame fallbacks.
 */
export async function loadBuildingAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string));
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) =>
        reject(new Error(`building atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}
