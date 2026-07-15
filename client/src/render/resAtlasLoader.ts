/**
 * resAtlasLoader.ts — SLG resource motif atlas loader.
 *
 * Five hand-drawn stationery motifs (ink / paper / graphite / metal / sticker),
 * each 128px on the long edge, packed into `assets/slg/res_atlas.{png,json}`.
 * Used by WorldMapScene.drawTileL1() to render resource-tile abundance clusters.
 *
 * Loading is fire-and-forget (L1 lazy — called on WorldMapScene construction).
 * A decode failure does not block the map; tiles fall back to color-only rendering.
 * Motif lines are black hand-drawn and must NOT be tinted.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/slg/res_atlas.png';
import atlasData from '../assets/slg/res_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the atlas PNG has decoded and frames are parsed. */
export function isResAtlasReady(): boolean {
  return sheet !== null;
}

/** Texture for a resource type's generic frame (e.g. `res_ink`), or null if not ready/unknown. */
export function getResTexture(resType: string): PIXI.Texture | null {
  return sheet ? (sheet.textures[`res_${resType}`] ?? null) : null;
}

/**
 * Texture for a resource type's exact-LEVEL frame (e.g. `res_ink_l7`), or null if that
 * specific level's art hasn't been produced yet. Unlike `getResTexture`, this has no
 * fallback — callers use the null to decide whether to fall back to the generic motif's
 * count/alpha simulation instead. Lets per-level art drop in resType-by-resType,
 * level-by-level with zero code change (mirrors cityAtlasLoader's getCityTextureForLevel).
 */
export function getResLevelTexture(resType: string, level: number): PIXI.Texture | null {
  if (!sheet) return null;
  const lv = Math.max(1, Math.min(10, Math.round(level)));
  return sheet.textures[`res_${resType}_l${lv}`] ?? null;
}

/**
 * Decode + parse the resource motif atlas. Idempotent: concurrent / repeat calls
 * share one in-flight promise. Rejects on PNG decode error; callers may ignore
 * the result (motifs are optional ambience, color-only fallback always works).
 */
export async function loadResAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    // Explicit mipmap + linear filtering: these motifs are drawn at 128px on the atlas but
    // displayed as tiny 15-34px HUD icons (~4-8x downscale), which without trilinear mipmap
    // sampling reads as muddy/blurry line art instead of a crisp shrink.
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string), {
      scaleMode: PIXI.SCALE_MODES.LINEAR,
      mipmap: PIXI.MIPMAP_MODES.ON,
    });
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) => reject(new Error(`res atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}
