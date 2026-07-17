/**
 * cityBldAtlasLoader.ts — CityScene ("Home Desk") building icon atlas loader.
 *
 * Five hand-drawn stationery-themed building icons, packed into
 * `assets/slg/city_bld_atlas.{png,json}`: bld_desk / bld_cabinet / bld_drillYard /
 * bld_wall / bld_satchel. Replaces the programmatic icons.ts line-art (desk/cabinet/
 * drillYard/wall) and emoji fallback (satchel) previously used by CityScene.bldIcon().
 *
 * Loading is fire-and-forget (called from CityScene.load()). A decode failure falls
 * back to the pre-existing programmatic/emoji icon — see CityScene.bldIcon().
 * Motif lines are black hand-drawn and must NOT be tinted.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/slg/city_bld_atlas.png';
import atlasData from '../assets/slg/city_bld_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the atlas PNG has decoded and frames are parsed. */
export function isCityBldAtlasReady(): boolean {
  return sheet !== null;
}

/** Texture for a building frame (e.g. `bld_desk`), or null if not ready/unknown. */
export function getCityBldTexture(name: string): PIXI.Texture | null {
  return sheet ? (sheet.textures[name] ?? null) : null;
}

/**
 * Decode + parse the city building icon atlas. Idempotent; concurrent calls share
 * one in-flight promise. Rejects on PNG decode error; callers fall back to the
 * pre-existing programmatic/emoji icon.
 */
export async function loadCityBldAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    // Source frames are 256px but rendered as small ~22-60px grid/header icons
    // (4-10x downscale) — mipmap + linear filtering keeps the shrink crisp instead
    // of muddy (same reasoning as resAtlasLoader).
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string), {
      scaleMode: PIXI.SCALE_MODES.LINEAR,
      mipmap: PIXI.MIPMAP_MODES.ON,
    });
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) => reject(new Error(`city building atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}
