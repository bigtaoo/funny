// Pure item-class label/icon helpers shared across AuctionScene's list/bid/create-listing panels — no
// scene state (`core`), just item data in → label/glyph out. Split out of the former AuctionSceneBase
// mixin during the 2026-08-11 composition conversion; see claudedocs/client-modules.md's split-form
// priority note — these never touched `this` beyond calling each other, so they're plain form①
// functions instead of Core methods.
import { t, type TranslationKey } from '../../i18n';
import type { IconKind } from '../../render/icons';
import type { AuctionView } from '../../net/WorldApiClient';
import type { EquipmentInstance, CardInstance } from '../../game/meta/SaveData';
import { EQUIP_MAX_LEVEL } from '../../game/meta/equipmentDefs';
import { MAX_CARD_LEVEL } from '../../game/meta/cardDefs';
import { levelStarsText } from '../../render/levelStars';
import { skinDisplayName } from '../../game/meta/skinDefs';

/** Equipment display name from i18n (`equip.<defId>.name`); falls back to the raw defId. */
export function equipName(defId: string): string {
  const key = `equip.${defId}.name` as TranslationKey;
  const s = t(key);
  return s === key ? defId : s;
}

/** Card display name from i18n (`card.<defId>.name`); falls back to the raw defId. */
export function cardName(defId: string): string {
  const key = `card.${defId}.name` as TranslationKey;
  const s = t(key);
  return s === key ? defId : s;
}

// ── Icon resolution ────────────────────────────────────────────────────────
// Reuses existing icons.ts glyphs (no new definitions): equipment→shield, card→card
// stack, material→its own material glyph; sale-mode fixed→price tag, auction→gavel(hammer).

/** Glyph for an item class / listing item type. */
export function itemKind(itemType: string | undefined, material?: string): IconKind {
  if (itemType === 'equipment') return 'armor';
  if (itemType === 'card') return 'cards';
  if (itemType === 'skin') return 'brush';
  return (material ?? 'scrap') as IconKind;
}

/** Glyph for a sale mode: fixed buy-now → price tag, auction → gavel. */
export function saleModeKind(mode: 'fixed' | 'auction'): IconKind {
  return mode === 'auction' ? 'hammer' : 'tag';
}

/**
 * Human label for a listing row/title, per item class — bare item name for equipment/card (no level
 * suffix at all; a raw "+N"/"Lv.N" read as noise once every other item view had already moved to
 * stars — see 08.08.2026 report). list.ts draws the level as a real gold-icon star row beneath this
 * instead (see auctionItemLevel); text-only contexts with no room for a separate icon row use
 * auctionLabelText below, which folds the level back in as text stars.
 */
export function auctionLabel(auc: AuctionView): string {
  if (auc.itemType === 'equipment') {
    const inst = auc.item?.['instance'] as EquipmentInstance | undefined;
    return inst ? equipName(inst.defId) : t('auction.filterEquipment');
  }
  if (auc.itemType === 'card') {
    const inst = auc.item?.['instance'] as CardInstance | undefined;
    return inst ? cardName(inst.defId) : t('auction.filterCard');
  }
  if (auc.itemType === 'skin') {
    const skinId = auc.item?.['skinId'] as string | undefined;
    return skinId ? skinDisplayName(skinId) : t('auction.filterSkin');
  }
  const mat = (auc.item?.['material'] as string | undefined) ?? 'scrap';
  return `${t(`auction.${mat as 'scrap' | 'lead' | 'binding'}`)} ×${auc.qty}`;
}

/** Enhancement/character level for a listing (0 for material/skin, or an instance-backed listing
 *  whose snapshot is missing) — list.ts uses this to draw a real gold-icon star row beneath the
 *  name (mirrors EquipmentScene/CardScene.buildLevelStars). */
export function auctionItemLevel(auc: AuctionView): number {
  if (auc.itemType === 'equipment') {
    const inst = auc.item?.['instance'] as EquipmentInstance | undefined;
    return inst?.level ?? 0;
  }
  if (auc.itemType === 'card') {
    const inst = auc.item?.['instance'] as CardInstance | undefined;
    return inst?.level ?? 0;
  }
  return 0;
}

/** Clamp cap for auctionItemLevel's star row — matches the item class's own max level. */
export function auctionItemMaxLevel(auc: AuctionView): number {
  return auc.itemType === 'card' ? MAX_CARD_LEVEL : EQUIP_MAX_LEVEL;
}

/** auctionLabel, with the equipment/card level folded back in as text stars (e.g. "Foil Cover ★★★")
 *  instead of the old "+N"/"Lv.N" — for text-only slots with no room for a separate icon-star row
 *  (the bid modal title). Mirrors EquipmentScene.itemLabel's text-star convention. */
export function auctionLabelText(auc: AuctionView): string {
  const base = auctionLabel(auc);
  const stars = levelStarsText(auctionItemLevel(auc), auctionItemMaxLevel(auc));
  return stars ? `${base} ${stars}` : base;
}
