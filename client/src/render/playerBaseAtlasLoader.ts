/**
 * playerBaseAtlasLoader.ts — player's own base sprite atlas loader.
 *
 * Hand-drawn "stationery fortress" images, one per desk level (1-10), packed into
 * `assets/slg/playerbase_atlas.{png,json}` (see art/ui/slg-playerbase/pack_playerbase_atlas.js).
 * Deliberately a separate atlas + theme from cityAtlasLoader's castle/fort art: this one renders
 * only the requester's own base tile (tile.mine), driven by desk building level rather than the
 * tile's terrain-generated `level`. Other bases and NPC map cities keep using cityAtlasLoader.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/slg/playerbase_atlas.png';
import atlasData from '../assets/slg/playerbase_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the atlas PNG has decoded and frames are parsed. */
export function isPlayerBaseAtlasReady(): boolean {
  return sheet !== null;
}

/** Texture for the player's own base at a given desk level (1-10). No tier fallback — every level has its own frame. */
export function getPlayerBaseTextureForLevel(level: number): PIXI.Texture | null {
  if (!sheet) return null;
  const lv = Math.max(1, Math.min(10, Math.round(level)));
  return sheet.textures[`playerbase_l${lv}`] ?? null;
}

/**
 * Fraction (0-1) of the packed 256px cell that's transparent padding above the bottom-aligned
 * building art — see cityAtlasLoader.getCityContentTopFracForLevel for why this matters (the
 * city-layer HP bar in WorldMapRenderer/city.ts needs it to avoid floating above short buildings).
 * Falls back to 0 if the atlas predates the `contentTop` field. Unlike getPlayerBaseTextureForLevel,
 * this doesn't need the PNG decoded (no `sheet` gate) — the value comes straight off the bundled
 * JSON, available as soon as the module loads.
 */
export function getPlayerBaseContentTopFracForLevel(level: number): number {
  const lv = Math.max(1, Math.min(10, Math.round(level)));
  const frames = (atlasData as { frames: Record<string, { contentTop?: number }> }).frames;
  return frames[`playerbase_l${lv}`]?.contentTop ?? 0;
}

/**
 * Decode + parse the player-base atlas. Idempotent; concurrent calls share one
 * in-flight promise. Failure is non-fatal — the base falls back to the shared
 * city atlas (see WorldMapRenderer/city.ts).
 */
export async function loadPlayerBaseAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string));
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) =>
        reject(new Error(`player base atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}
