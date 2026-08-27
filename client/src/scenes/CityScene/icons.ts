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

// ── Icon chip (2026-08-27) ─────────────────────────────────────────────────────────────────────
// A tinted rounded square behind the motif, in the same accent the card's level stripe and the
// resource bar's band already use.
//
// Half of the "主城图标太淡" report is the art (fixed at the source — see pack_resources.cjs
// UI_INK_FLOOR), but the other half is structural and no amount of ink fixes it: every one of these
// motifs is an OUTLINE with a transparent middle, sitting on a paper background. There is no
// silhouette to catch the eye — only strokes — so the icons read as smudges on the page rather than
// as objects, and the eye has to resolve the drawing before it can tell one card from another.
// The chip gives each motif a ground: the tint shows through the open middle, which is exactly where
// an outline drawing has nothing of its own, and the shape reads at a glance before the lines do.
//
// Deliberately NOT folded into resIcon/bldIcon themselves — the same two functions also draw the
// 15px cost icons inside the upgrade modal and the wall glyph in the header, where a chip behind
// every inline number would be noise. Call sites opt in.
//
// And it goes on the RESOURCE MOTIFS only — the resource bar, and the five producer cards that reuse
// a resource motif as their glyph. Screenshotted on both, 2026-08-27: behind the hand-drawn bld_*
// art (desk / cabinet / drillYard / wall / satchel / academy, and the train tile's armour glyph) it
// actively hurts. Those drawings already fill their box edge to edge and are dense and dark, so the
// chip has no open middle to fill; it just crops their corners on its own rounded edge and lays a
// tint under fine hatching that was reading perfectly well on bare paper. Wall came out a salmon
// blob and Drill Yard lost its hatch.
//
// The split is not a compromise — it says something true. A chip means "this card produces that
// resource", in the same colour the bar above it uses for that resource, which is exactly the line
// BLD_RES already draws. The seven cards without one are the seven that produce nothing.
const CHIP_INSET = 0.86;    // motif edge-to-edge inside the chip; leaves a ground visible around it without shrinking the drawing enough to cost detail
const CHIP_ALPHA = 0.34;    // enough ground to read against C.paper, light enough that the black pen stays the darkest thing in the cell
const CHIP_RADIUS = 0.26;   // matches the card corner rounding
/** Node name on every chip container. Which cards got one is the whole design decision above, so the test that pins it needs to find them without guessing at positions in the display list. */
export const CHIP_NODE_NAME = 'cityIconChip';

/** The resource a building produces, or undefined — the five cards whose glyph IS a resource motif, and therefore the five that take a chip. */
export function producerResource(key: BuildingKey): ResourceType | undefined {
  return BLD_RES[key];
}

// Chip tint = the accent, except graphite. Its accent is a near-neutral pencil grey (0xb0b0a8) which
// at chip alpha lands within a couple of percent of the paper under it — i.e. no chip at all. Darkened
// here only: the accent bar and the level stripe draw the same colour as a solid band where its
// lightness reads fine, and changing it there would recolour the whole graphite column for no reason.
const CHIP_TINT: Partial<Record<ResourceType, number>> = { graphite: 0x8f8f86 };
export function chipTint(color: number): number {
  for (const [rt, tint] of Object.entries(CHIP_TINT)) {
    if (RES_COLORS[rt as ResourceType] === color) return tint;
  }
  return color;
}

/**
 * Wrap a motif in a tinted chip. The returned container occupies exactly `size`×`size`, so a call
 * site can swap `bldIcon(k, 60, …)` for `chipped(60, …, (n) => bldIcon(k, n, …))` without touching
 * its own layout; the motif shrinks to CHIP_INSET inside instead.
 */
export function chipped(
  size: number,
  color: number,
  make: (inner: number) => PIXI.DisplayObject
): PIXI.Container {
  const box = new PIXI.Container();
  box.name = CHIP_NODE_NAME;
  const chip = new PIXI.Graphics();
  chip.beginFill(chipTint(color), CHIP_ALPHA);
  chip.drawRoundedRect(0, 0, size, size, size * CHIP_RADIUS);
  chip.endFill();
  box.addChild(chip);

  const inner = Math.round(size * CHIP_INSET);
  const motif = make(inner);
  motif.x = (size - inner) / 2;
  motif.y = (size - inner) / 2;
  box.addChild(motif);
  return box;
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
