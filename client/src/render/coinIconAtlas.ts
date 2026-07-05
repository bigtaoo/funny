/**
 * coinIconAtlas.ts — recharge-tier coin icon bitmap atlas.
 *
 * 5 AI-generated icons (384×256, 3×2 grid, 128×128 each) loaded as a PixiJS
 * Spritesheet, one per ShopScene coin tier: coin / coins / coinStack /
 * coinSack / coinChest (frame names match the matching `IconKind` in
 * render/icons.ts). `getCoinIconTexture(kind)` returns the frame; callers
 * fall back to the procedural `buildIcon` draw if the atlas isn't loaded yet
 * or the kind has no AI art.
 *
 * Loaded lazily by ShopScene on construction (not part of the L0 boot
 * manifest — the shop is not on the first-battle critical path). A failed
 * load is non-fatal; the scene degrades to the procedural icon.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/shop/coins.png';
import atlasData from '../assets/shop/coins.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the atlas PNG has decoded and frames are parsed. */
export function isCoinIconAtlasReady(): boolean {
  return sheet !== null;
}

/**
 * Texture for a coin-tier frame (`coin` | `coins` | `coinStack` | `coinSack` |
 * `coinChest`), or null if not loaded / unknown. Callers fall back to the
 * procedural glyph on null.
 */
export function getCoinIconTexture(kind: string): PIXI.Texture | null {
  return sheet ? (sheet.textures[kind] ?? null) : null;
}

/**
 * Decode + parse the atlas. Idempotent; concurrent calls share one in-flight
 * promise. Rejects on decode error (callers should log + degrade gracefully).
 */
export async function loadCoinIconAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string));
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) => reject(new Error(`coin icon atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}
