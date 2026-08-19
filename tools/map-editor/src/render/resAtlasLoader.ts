/**
 * resAtlasLoader.ts — same SLG resource-motif atlas the game client renders
 * (client/src/render/resAtlasLoader.ts). See terrainAtlasLoader.ts header for why
 * this copy skips assetIO.
 */
import * as PIXI from 'pixi.js-legacy';
import type { ResMotifFrameRead } from '@nw/shared/slg';
import atlasUrl from '../assets/slg/res_atlas.png';
import atlasData from '../assets/slg/res_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

export function isResAtlasReady(): boolean {
  return sheet !== null;
}

export function getResTexture(resType: string): PIXI.Texture | null {
  return sheet ? (sheet.textures[`res_${resType}`] ?? null) : null;
}

/** Exact-LEVEL frame (e.g. `res_ink_l7`), or null if that level's art doesn't exist yet. */
export function getResLevelTexture(resType: string, level: number): PIXI.Texture | null {
  if (!sheet) return null;
  const lv = Math.max(1, Math.min(10, Math.round(level)));
  return sheet.textures[`res_${resType}_l${lv}`] ?? null;
}

/**
 * The solved level read (`nw`) the resource packer baked into this frame — mirrors the game client's
 * getResFrameRead. Reads the bundled JSON directly (PIXI's Spritesheet drops unknown frame keys, so
 * `nw` never reaches the Texture), hence no `sheet` gate.
 */
export function getResFrameRead(frameName: string): ResMotifFrameRead | null {
  const frames = (atlasData as { frames: Record<string, { nw?: ResMotifFrameRead }> }).frames;
  return frames[frameName]?.nw ?? null;
}

export async function loadResAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(atlasUrl as string);
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
