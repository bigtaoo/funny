/**
 * cityAtlasLoader.ts — SLG city sprite atlas loader for the map editor.
 *
 * Copied from the game client's client/src/render/cityAtlasLoader.ts (art-parity, DESIGN.md §6.3) with the
 * assetIO indirection dropped — the editor is web-only, so the atlas URL is used directly as a
 * PIXI.BaseTexture source (same simplification as terrainAtlasLoader.ts).
 *
 * The bundled atlas currently ships 4 tier frames (city_lv1..city_lv4, camp/fort/castle/citadel spanning
 * levels 1-2/3-5/6-8/9-10). getCityTextureForLevel() prefers a per-level frame `city_l{level}` when the
 * atlas provides it (the 10-image set) and otherwise falls back to the tier frame — so the 6 not-yet-drawn
 * per-level images can drop in later with zero code change.
 */
import * as PIXI from 'pixi.js-legacy';
import { cityTier } from '@nw/shared/slg';
import atlasUrl from '../assets/slg/city_atlas.png';
import atlasData from '../assets/slg/city_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

export function isCityAtlasReady(): boolean {
  return sheet !== null;
}

/** Texture for a specific city LEVEL (1–10): per-level frame `city_l{level}` if present, else the tier frame `city_lv{tier}`. */
export function getCityTextureForLevel(level: number): PIXI.Texture | null {
  if (!sheet) return null;
  const lv = Math.max(1, Math.min(10, Math.round(level)));
  return sheet.textures[`city_l${lv}`] ?? sheet.textures[`city_lv${cityTier(lv)}`] ?? null;
}

export async function loadCityAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(atlasUrl as string);
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) => reject(new Error(`city atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}
