/**
 * cityAtlasLoader.ts — SLG city (main base) sprite atlas loader.
 *
 * Four hand-drawn city images at 256 px each, packed into
 * `assets/slg/city_atlas.{png,json}`:
 *   city_lv1 — camp (tier 1, lv 1-2)
 *   city_lv2 — wooden fort (tier 2, lv 3-5)
 *   city_lv3 — stone castle (tier 3, lv 6-8)
 *   city_lv4 — grand castle (tier 4, lv 9-10)
 *
 * Used by WorldMapScene to render each base tile as a 3×3-tile sprite that
 * overrides the programmatic city icon once the atlas is decoded.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/slg/city_atlas.png';
import atlasData from '../assets/slg/city_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the atlas PNG has decoded and frames are parsed. */
export function isCityAtlasReady(): boolean {
  return sheet !== null;
}

/**
 * Texture for a city tier (1–4).
 *   Tier 1 → city_lv1 (lv 1-2)
 *   Tier 2 → city_lv2 (lv 3-5)
 *   Tier 3 → city_lv3 (lv 6-8)
 *   Tier 4 → city_lv4 (lv 9-10)
 */
export function getCityTexture(tier: 1 | 2 | 3 | 4): PIXI.Texture | null {
  return sheet ? (sheet.textures[`city_lv${tier}`] ?? null) : null;
}

/**
 * Decode + parse the city atlas. Idempotent; concurrent calls share one
 * in-flight promise. Failure is non-fatal — tiles fall back to the
 * programmatic city icon.
 */
export async function loadCityAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string));
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) =>
        reject(new Error(`city atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}
