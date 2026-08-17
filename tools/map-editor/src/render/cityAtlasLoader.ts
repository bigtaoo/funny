/**
 * cityAtlasLoader.ts — SLG city sprite atlas loader for the map editor.
 *
 * Copied from the game client's client/src/render/cityAtlasLoader.ts (art-parity, DESIGN.md §6.3) with the
 * assetIO indirection dropped — the editor is web-only, so the atlas URL is used directly as a
 * PIXI.BaseTexture source (same simplification as terrainAtlasLoader.ts).
 *
 * The bundled atlas ships one dedicated frame per level (`city_l1..city_l10`). Until 2026-08-14
 * levels 1/3/6/9 had no dedicated art and fell back to 4 pre-redesign "tier" frames
 * (`city_lv1..lv4`); once the last of those was redrawn, all 10 levels were unified onto this flat
 * naming and the tier fallback was dropped. Repacked by art/slg/slg-building/pack_city_atlas.js.
 */
import * as PIXI from 'pixi.js-legacy';
import atlasUrl from '../assets/slg/city_atlas.png';
import atlasData from '../assets/slg/city_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

export function isCityAtlasReady(): boolean {
  return sheet !== null;
}

/** Texture for a specific city LEVEL (1–10): the dedicated frame `city_l{level}`. */
export function getCityTextureForLevel(level: number): PIXI.Texture | null {
  if (!sheet) return null;
  const lv = Math.max(1, Math.min(10, Math.round(level)));
  return sheet.textures[`city_l${lv}`] ?? null;
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
