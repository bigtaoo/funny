/**
 * buildingAtlasLoader.ts — same SLG overlay-building atlas the game client renders
 * (client/src/render/buildingAtlasLoader.ts). See terrainAtlasLoader.ts header for
 * why this copy skips assetIO.
 */
import * as PIXI from 'pixi.js-legacy';
import atlasUrl from '../assets/slg/building_atlas.png';
import atlasData from '../assets/slg/building_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

export function isBuildingAtlasReady(): boolean {
  return sheet !== null;
}

/** Texture for a building frame (`building_keep` | `building_stronghold` | `icon_watchtower`), or null. */
export function getBuildingTexture(name: string): PIXI.Texture | null {
  return sheet ? (sheet.textures[name] ?? null) : null;
}

export async function loadBuildingAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(atlasUrl as string);
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) => reject(new Error(`building atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}
