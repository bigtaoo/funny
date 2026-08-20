/**
 * terrainAtlasLoader.ts — same SLG ground-tile atlas the game client renders
 * (client/src/render/terrainAtlasLoader.ts), copied here so the editor draws the
 * exact hand-drawn textures instead of flat debug colors. Simplified vs. the client
 * original: no assetIO indirection (the editor is web-only, never WeChat), so the
 * atlas URL is used directly as a PIXI.BaseTexture source.
 */
import * as PIXI from 'pixi.js-legacy';
import atlasUrl from '../assets/slg/terrain_atlas.png';
import atlasData from '../assets/slg/terrain_atlas.json';
// The frame-name union lives in the pure tile layer, which is what maps a tile to one of these
// names; this loader only turns a name into a PIXI.Texture. See tiles/tileStyle.ts for why the
// dependency points that way.
import type { TerrainTextureName } from '../tiles/tileStyle';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

export function isTerrainAtlasReady(): boolean {
  return sheet !== null;
}

export function getTerrainTexture(name: TerrainTextureName): PIXI.Texture | null {
  return sheet ? (sheet.textures[name] ?? null) : null;
}

export async function loadTerrainAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(atlasUrl as string);
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
