/**
 * materialAtlas.ts — crafting-material icon bitmap atlas.
 *
 * 3 AI-generated stationery icons (384×128, 3×1 grid, 128×128 each) loaded as a
 * PixiJS Spritesheet. Frame names are the short material ids `scrap` / `lead` /
 * `binding` (same ids EquipmentScene tracks and GachaScene.MATERIAL_ICON maps
 * mat_* itemIds onto). When the atlas is ready, `getMaterialIconTexture(kind)`
 * returns the frame; callers fall back to the procedural `buildIcon` glyph
 * (icons.ts drawScrap/drawLead/drawBinding) when the atlas is not loaded yet.
 *
 * Mirrors equipmentAtlas.ts: loaded once at boot (bootManifest L0), cosmetic —
 * a failed load is non-fatal and degrades to the procedural glyph.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/material/material.png';
import atlasData from '../assets/material/material.json';
import { buildIcon, type IconKind } from './icons';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** The material kinds backed by an atlas frame. */
export type MaterialKind = 'scrap' | 'lead' | 'binding';

/** True once the atlas PNG has decoded and frames are parsed. */
export function isMaterialAtlasReady(): boolean {
  return sheet !== null;
}

/** Texture for a material kind (`scrap`/`lead`/`binding`), or null if not loaded / unknown. */
export function getMaterialIconTexture(kind: string): PIXI.Texture | null {
  return sheet ? (sheet.textures[kind] ?? null) : null;
}

/** Decode + parse the atlas. Idempotent. Rejects on decode error (callers degrade gracefully). */
export async function loadMaterialAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string));
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) => reject(new Error(`material atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}

/**
 * Single source of truth for a crafting-material picture. Returns the AI bitmap
 * sprite from the atlas when it is loaded and the kind is known, otherwise the
 * procedural ink glyph (icons.ts). The returned DisplayObject fits a `size`×`size`
 * box with its top-left at the origin (matching `buildIcon`'s contract) — callers
 * set `.x/.y` to the box's top-left. Every material-icon site (gacha reveal + odds,
 * equipment materials band, level/daily/event/battle-pass reward rows) MUST go
 * through here so the same material reads the same everywhere.
 */
export function buildMaterialIcon(kind: MaterialKind, size: number, color: number): PIXI.DisplayObject {
  const tex = getMaterialIconTexture(kind);
  if (tex) {
    const sprite = new PIXI.Sprite(tex);
    sprite.width = size;
    sprite.height = size;
    return sprite;
  }
  return buildIcon(kind as IconKind, size, color);
}
