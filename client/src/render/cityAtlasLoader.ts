/**
 * cityAtlasLoader.ts — SLG city (main base) sprite atlas loader.
 *
 * Hand-drawn city images at 256 px each, packed into `assets/slg/city_atlas.{png,json}`
 * (see art/ui/slg-building/pack_city_atlas.js):
 *   Tier fallbacks — city_lv1 camp / city_lv2 wooden fort / city_lv3 stone castle / city_lv4 grand
 *     citadel, spanning lv 1-2 / 3-5 / 6-8 / 9-10.
 *   Per-level frames — city_l2/l4/l5/l7/l8/l10 give those levels their own art so adjacent levels
 *     visibly progress; levels without a per-level frame (1/3/6/9) fall back to their tier frame.
 *
 * Used by WorldMapScene to render each base tile as a 3×3-tile sprite that
 * overrides the programmatic city icon once the atlas is decoded.
 */
import * as PIXI from 'pixi.js-legacy';
import { cityTier } from '@nw/shared';
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
 * Texture for a specific city LEVEL (1–10). Prefers a per-level frame `city_l{level}` (the 10-image art
 * set) when the atlas provides it; otherwise falls back to the 4-tier frame `city_lv{tier}`. This lets the
 * 6 not-yet-produced per-level images drop in later with zero code change — until then every level renders
 * its tier image, exactly as before.
 */
export function getCityTextureForLevel(level: number): PIXI.Texture | null {
  if (!sheet) return null;
  const lv = Math.max(1, Math.min(10, Math.round(level)));
  return sheet.textures[`city_l${lv}`] ?? sheet.textures[`city_lv${cityTier(lv)}`] ?? null;
}

/**
 * Fraction (0-1) of the packed 256px cell that's transparent padding above the bottom-aligned
 * building art, for the same frame getCityTextureForLevel(level) would resolve — see the
 * `contentTop` field pack_city_atlas.js bakes into city_atlas.json. Every tier fills a different
 * amount of the fixed cell (a lv1 camp barely reaches halfway; a lv10 citadel nearly fills it), so
 * anything positioning itself off the sprite's full height (e.g. the city-layer HP bar in
 * WorldMapRenderer/city.ts) needs this to land just above the ACTUAL art instead of floating above
 * mostly-empty padding. Falls back to 0 (assume the art fills the cell) if the atlas predates this
 * field. Unlike getCityTextureForLevel, this doesn't need the PNG decoded (no `sheet` gate) — the
 * value comes straight off the bundled JSON, available as soon as the module loads.
 */
export function getCityContentTopFracForLevel(level: number): number {
  const lv = Math.max(1, Math.min(10, Math.round(level)));
  const frames = (atlasData as { frames: Record<string, { contentTop?: number }> }).frames;
  const frame = frames[`city_l${lv}`] ?? frames[`city_lv${cityTier(lv)}`];
  return frame?.contentTop ?? 0;
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
