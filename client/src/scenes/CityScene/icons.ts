// CitySceneCore's resource/building glyph resolution, extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛") — pure lookups against module-singleton
// texture caches (getResTexture/getCityBldTexture), no Core state needed at all.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import type { BuildingKey } from '../../net/WorldApiClient';
import { type ResourceType } from '@nw/shared';
import { getResTexture } from '../../render/atlas/resAtlasLoader';
import { getCityBldTexture } from '../../render/atlas/cityBldAtlasLoader';
import { buildIcon, type IconKind } from '../../render/icons';

export const RES_COLORS: Readonly<Record<ResourceType, number>> = {
  ink: 0xa8d870,
  paper: 0x90b860,
  graphite: 0xb0b0a8,
  metal: 0xa0b8c8,
  sticker: 0xe6b8d0,
};

// Emoji fallbacks — only used while res_atlas is still decoding (rare: the atlas is
// a module singleton usually already loaded by WorldMapScene before city entry).
const RES_ICON: Readonly<Record<ResourceType, string>> = {
  ink: '🖊',
  paper: '📄',
  graphite: '✏️',
  metal: '🔩',
  sticker: '🏷',
};

const BLD_ICON: Readonly<Record<BuildingKey, string>> = {
  desk: '🗂',
  inkPot: '🖊',
  paperTray: '📄',
  graphiteMill: '✏️',
  metalForge: '🔩',
  stickerShop: '🏷',
  cabinet: '🗄',
  drillYard: '⚔️',
  wall: '🏯',
  academy: '📚',
  satchel: '🎒',
};

// Building glyph source: the five resource-producer buildings reuse the res_atlas
// motif of what they yield (strong resource↔building visual link, zero new art);
// the rest use hand-drawn icons.ts line-art.
const BLD_RES: Partial<Record<BuildingKey, ResourceType>> = {
  inkPot: 'ink',
  paperTray: 'paper',
  graphiteMill: 'graphite',
  metalForge: 'metal',
  stickerShop: 'sticker',
};
const BLD_GLYPH: Partial<Record<BuildingKey, IconKind>> = {
  desk: 'desk',
  cabinet: 'cabinet',
  drillYard: 'swords',
  wall: 'castle',
  academy: 'book',
};

// Hand-drawn atlas art (art/slg/slg-desk → city_bld_atlas) supersedes the BLD_GLYPH
// programmatic line-art / emoji fallback once the atlas has decoded. `academy` added
// 2026-08-17 — it was the one BuildingKey left out of the 2026-07-17 batch with no
// rationale on record (see design/product/slg-citybld-icon-prompts.md); now closed.
const BLD_ATLAS: Partial<Record<BuildingKey, string>> = {
  desk: 'bld_desk',
  cabinet: 'bld_cabinet',
  drillYard: 'bld_drillYard',
  wall: 'bld_wall',
  satchel: 'bld_satchel',
  academy: 'bld_academy',
};

// Category accent for the building grid's level-progress stripe (2026-08-01 card redesign): ties
// producer cards to the resource-bar color language above them, and gives the remaining buildings
// a category tint so the grid reads as groups rather than one undifferentiated row of look-alikes.
const MILITARY_COLOR = 0xb85c38;
export function bldAccentColor(key: BuildingKey): number {
  const res = BLD_RES[key];
  if (res) return RES_COLORS[res];
  if (key === 'drillYard' || key === 'wall') return MILITARY_COLOR;
  return C.accent as number;
}

/** Resource glyph: res_atlas motif sprite when decoded, else the emoji fallback. */
export function resIcon(rt: ResourceType, size: number): PIXI.DisplayObject {
  const tex = getResTexture(rt);
  if (tex) {
    const sp = new PIXI.Sprite(tex);
    sp.width = sp.height = size;
    return sp;
  }
  return txt(RES_ICON[rt], snapFont(Math.round(size * 0.85)), C.dark);
}

/** Building glyph: producer→res_atlas motif, hand-drawn city_bld_atlas art, then icons.ts line-art, emoji as last resort. */
export function bldIcon(key: BuildingKey, size: number, color: number): PIXI.DisplayObject {
  const res = BLD_RES[key];
  if (res) return resIcon(res, size);
  const frame = BLD_ATLAS[key];
  const tex = frame ? getCityBldTexture(frame) : null;
  if (tex) {
    const sp = new PIXI.Sprite(tex);
    sp.width = sp.height = size;
    return sp;
  }
  const kind = BLD_GLYPH[key];
  if (kind) return buildIcon(kind, size, color);
  return txt(BLD_ICON[key], snapFont(Math.round(size * 0.85)), color);
}
