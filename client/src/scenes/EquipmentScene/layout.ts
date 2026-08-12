// Shared grid-layout constants + pure drawing/layout primitives for the EquipmentScene composition
// (see ../EquipmentScene.ts assembly and ./core.ts's file-header comment) — form① free functions with
// no Core delegate methods, split out of core.ts purely to keep it under the 500-line convention
// (claudedocs/client-modules.md's split-form priority note). Every caller (core.ts, and each domain
// class) imports directly from here rather than going through a `core.xxx()` wrapper.
import type { EquipRarity, EquipSlot } from '../../game/meta/SaveData';
import type { IconKind } from '../../render/icons';
import type { EquipGridLayout } from './types';

export const RES_H = 30;       // resource bar (coins + three materials + inventory count)
export const LOADOUT_H = 90;   // loadout strip at the top of the inventory tab (three slots) — tall enough for icon+name+enhance-stars to stack without the stars clipping the slot cell's bottom border (2026-08-01)
export const ROW_H = 56;
export const FILTER_H = 48;   // slot filter bar (All / Weapon / Armor / Trinket)
export const MAT_BAND_H = 52; // materials band (scrap / lead / binding) below the header
export const SECTION_H = 36;  // section divider (Equipped / Bag) — clickable to collapse, text is 2x the previous size
// Top padding above the first section header, tighter than the inter-row CELL_GAP (2026-08-01):
// using CELL_GAP there read as an oversized gap under the loadout strip, since LOADOUT_H already
// carries its own bottom breathing room.
export const LIST_TOP_PAD = 12;
// Gap between the slot filter bar and the loadout strip beneath it (2026-08-01) — see core.ts's renderHeaderRow.
export const TAB_LOADOUT_GAP = 14;

// Inventory grid: icon-card cells (name top / glyph left / rarity+level right)
// packed into columns sized to the wide (1920) landscape canvas.
export const CELL_GAP = 36;
export const CELL_GAP_X = CELL_GAP * 2; // horizontal gap between grid cells only — doubled per 2026-07-17 legibility pass
export const EQUIP_CELL_H = 266; // +50% atop the previous 177 (2026-07-16 inventory legibility pass)
export const EQUIP_CELL_W_TARGET = 360; // tightened from 480 (2026-07-17) — 480 left a wide empty band between the glyph and the craft/level column
// Portrait's fixed 1080 design width only ever fits two EQUIP_CELL_W_TARGET columns (avail ≈
// 1008), leaving a ~200px blank band on the right instead of a third column of content
// (2026-08-09 UX fix). Landscape's wider canvas already reaches 3+ target-width columns on its
// own, so this floor only ever kicks in for portrait's inventory grid — see InventoryPanel.
export const EQUIP_CELL_W_MIN = 260;
// Craft grid: same column + cell sizing as the inventory grid so the icon
// frames read at the same scale; cost chips + craft button sit beside the glyph.
export const CRAFT_CELL_H = EQUIP_CELL_H;

export const SLOTS: readonly EquipSlot[] = ['weapon', 'armor', 'trinket'];
export const TRACKED_MATERIALS = ['scrap', 'lead', 'binding'] as const;

/**
 * Rarity → accent color (shared visual language with gacha/collection).
 * Ascending grey → green → blue → purple so a higher tier always reads as
 * "more important" than a lower one (previously rare was orange, which read
 * louder/higher than epic's purple — inverted the intended hierarchy).
 */
export const RARITY_COLOR: Record<EquipRarity, number> = {
  common: 0x9aa0a6,
  fine: 0x4a9e4a,
  rare: 0x4477cc,
  epic: 0xaa55cc,
};

/** Material icon ink colors (three-pen language: scrap = paper grey / lead = graphite black / binding = ink blue). */
export const MAT_COLOR: Record<string, number> = {
  scrap: 0x8a8278,
  lead: 0x3a3632,
  binding: 0x2b4f8c,
};

/** Material id → icon kind (including coins); returns null for unknown materials (falls back to text label). */
export function matIconKind(id: string): IconKind | null {
  if (id === 'scrap' || id === 'lead' || id === 'binding') return id;
  if (id === 'coins' || id === 'coin') return 'coin';
  return null;
}

/**
 * Pure column-sizing math for the inventory grid, split out from `renderInventory` so it's unit-
 * testable without spinning up a full `EquipmentScene` (see `equipmentGridColumns.test.ts`) — the
 * only portrait-specific case worth pinning down in isolation is the centering fallback below,
 * which real portrait's fixed 1008 avail never actually exercises (it always divides evenly into
 * 3 exact columns, see the .ui.ts integration test), but a narrower/odd avail still must degrade
 * to it correctly.
 *
 * @param avail     Available width for the grid (screen width minus sidebar/margins).
 * @param landscape Whether the caller is in landscape — gates both the lower column-width floor
 *                  and the centering fallback to portrait only (see the two comments below).
 */
export function equipGridColumns(avail: number, landscape: boolean): EquipGridLayout {
  // Portrait's narrow avail (~1008) only ever clears one more EQUIP_CELL_W_TARGET column past the
  // first, leaving a wide blank band on the right (2026-08-09 UX fix) — drop the column floor to
  // EQUIP_CELL_W_MIN there so a slightly narrower third column fills that space with actual
  // content instead of margin. Landscape's much wider canvas already reaches 3+ target-width
  // columns without this, so it keeps the stricter floor (its own leftover is a thin,
  // proportionally minor margin — see the cellW cap comment below).
  const colFloor = landscape ? EQUIP_CELL_W_TARGET : EQUIP_CELL_W_MIN;
  const cols = Math.max(1, Math.floor((avail + CELL_GAP_X) / (colFloor + CELL_GAP_X)));
  // Cap at the target width instead of stretching to fill the row — dividing the full available
  // width evenly across `cols` left cards much wider than their content needed, reading as mostly
  // blank paper; any leftover width is just unused margin on the right.
  const cellW = Math.min(EQUIP_CELL_W_TARGET, (avail - CELL_GAP_X * (cols - 1)) / cols);
  // Center the row block when it still doesn't fill `avail` (e.g. a portrait screen narrower than
  // 3 min-width columns, falling back to 2) instead of hugging the left edge and leaving all the
  // slack on the right — the original complaint this whole function fixes.
  const rowW = cols * cellW + CELL_GAP_X * (cols - 1);
  const offset = !landscape ? Math.max(0, (avail - rowW) / 2) : 0;
  return { cols, cellW, offset };
}
