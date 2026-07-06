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
import { buildIcon, type IconKind } from './icons';
import atlasUrl from '../assets/shop/coins.png';
import atlasData from '../assets/shop/coins.json';

/** IconKinds with AI bitmap art in the atlas — matches the 5 ShopScene coin tiers. */
const AI_COIN_ICON_KINDS = new Set<IconKind>(['coin', 'coins', 'coinStack', 'coinSack', 'coinChest']);

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

/**
 * The single source of truth for "what a coin looks like" everywhere in the
 * client — the AI bitmap sprite once the atlas is loaded, falling back to the
 * procedural `buildIcon` glyph otherwise (e.g. before {@link loadCoinIconAtlas}
 * resolves, or for a kind with no AI art). Any header/balance display should
 * go through this rather than calling `buildIcon('coin', …)` directly, so the
 * lobby/shop/equipment/card/friends coin icons all stay visually identical.
 */
export function buildCoinIcon(kind: IconKind, size: number, color: number): PIXI.DisplayObject {
  const tex = AI_COIN_ICON_KINDS.has(kind) ? getCoinIconTexture(kind) : null;
  if (tex) {
    const sprite = new PIXI.Sprite(tex);
    sprite.width = size;
    sprite.height = size;
    return sprite;
  }
  return buildIcon(kind, size, color);
}
