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
import { iconsAtlas as atlas } from './iconsAtlas';
import { buildIcon, type IconKind } from '../icons';
import { tagIcon } from '../iconTag';

/** The material kinds backed by an atlas frame. */
export type MaterialKind = 'scrap' | 'lead' | 'binding';

/** True once the atlas PNG has decoded and frames are parsed. */
export const isMaterialAtlasReady = atlas.isReady;

/** Texture for a material kind (`scrap`/`lead`/`binding`), or null if not loaded / unknown. */
export const getMaterialIconTexture = atlas.getTexture;

/** Decode + parse the atlas. Idempotent. Rejects on decode error (callers degrade gracefully). */
export const loadMaterialAtlas = atlas.load;

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
    // Tagged on a WRAPPER, not on the sprite - same shape as buildInkIcon/buildRasterTabIcon, and
    // for a reason the audit cares about: `sprite.width = size` is implemented as
    // `scale = size / texture.width`, i.e. 20/128 for this atlas, and the gate reads world scale to
    // tell "someone shrank this group" from "this is its natural size". Tagging the sprite reported
    // every material chip in the game as shrunk to 1/6 (measured 2026-09-14: 23 false findings on
    // equipment+craft alone). The wrapper's own scale is 1, so the number means what the gate
    // thinks it means.
    const box = new PIXI.Container();
    box.addChild(sprite);
    return tagIcon(box, kind, size);   // layout-audit icon gate — see render/iconTag.ts
  }
  // The procedural fallback goes through buildIcon → buildInkIcon, which tags it itself.
  return buildIcon(kind as IconKind, size, color);
}
