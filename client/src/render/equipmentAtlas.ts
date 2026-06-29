/**
 * equipmentAtlas.ts — equipment icon bitmap atlas (EQUIPMENT_DESIGN §20.2).
 *
 * 12 AI-generated stationery icons (512×384, 4×3 grid, 128×128 each) loaded
 * as a PixiJS Spritesheet.  Frame names match defIds (§17.2): wp_pencil …
 * tk_seal.  When the atlas is ready, `getEquipIconTexture(defId)` returns the
 * frame; callers fall back to the procedural `drawEquipmentGlyph` if the atlas
 * is not loaded yet or the defId is unknown.
 *
 * Load once at app boot via `loadEquipmentAtlas` (added to bootManifest L0
 * because EquipmentScene can open from the campaign map lobby).  Cosmetic like
 * the decor atlases — a failed load is non-fatal; the scene degrades to the
 * procedural icon.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/equipment/equipment.png';
import atlasData from '../assets/equipment/equipment.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the atlas PNG has decoded and frames are parsed. */
export function isEquipAtlasReady(): boolean {
  return sheet !== null;
}

/**
 * Texture for a defId (e.g. `wp_pencil`), or null if not loaded / unknown.
 * Callers fall back to the procedural glyph on null.
 */
export function getEquipIconTexture(defId: string): PIXI.Texture | null {
  return sheet ? (sheet.textures[defId] ?? null) : null;
}

/**
 * Decode + parse the atlas.  Idempotent.  Rejects on decode error (callers
 * should log + degrade gracefully — the scene still works without icons).
 */
export async function loadEquipmentAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string));
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) => reject(new Error(`equipment atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}
