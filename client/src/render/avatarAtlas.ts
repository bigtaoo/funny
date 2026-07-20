/**
 * avatarAtlas.ts — preset player-avatar icon bitmap atlas.
 *
 * 8 AI-generated white-line doodles (book/trophy/swords/castle/pencils/globe/coin/home,
 * 256px frames) packed by art/ui/head/pack_avatar_atlas.cjs into a PixiJS Spritesheet.
 * Frame names match avatar.ts's AVATAR_DEFS IconKind strings. Mirrors materialAtlas.ts:
 * loaded once at boot (bootManifest L0), cosmetic — a failed load is non-fatal and
 * degrades to the procedural `buildIcon` glyph.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/avatars/avatars.png';
import atlasData from '../assets/avatars/avatars.json';
import { buildIcon, type IconKind } from './icons';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the atlas PNG has decoded and frames are parsed. */
export function isAvatarAtlasReady(): boolean {
  return sheet !== null;
}

/** Texture for a preset avatar icon key, or null if not loaded / unknown. */
export function getAvatarIconTexture(key: string): PIXI.Texture | null {
  return sheet ? (sheet.textures[key] ?? null) : null;
}

/** Decode + parse the atlas. Idempotent. Rejects on decode error (callers degrade gracefully). */
export async function loadAvatarAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string));
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) => reject(new Error(`avatar atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}

/**
 * Single source of truth for a preset avatar icon picture. Returns the AI bitmap
 * sprite from the atlas when it is loaded and the key is known, otherwise the
 * procedural ink glyph (icons.ts). The returned DisplayObject fits a `size`×`size`
 * box with its top-left at the origin (matching `buildIcon`'s contract).
 */
export function buildAvatarIcon(key: IconKind, size: number, color: number): PIXI.DisplayObject {
  const tex = getAvatarIconTexture(key);
  if (tex) {
    const sprite = new PIXI.Sprite(tex);
    sprite.width = size;
    sprite.height = size;
    return sprite;
  }
  return buildIcon(key, size, color);
}
