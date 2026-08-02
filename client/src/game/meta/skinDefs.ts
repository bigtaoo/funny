// Skin ↔ character binding (LOBBY_IA_REDESIGN §15 / ADR-038). Each ownable skin re-skins exactly one
// UnitType (server/shared/src/economy.ts SHOP_SKINS + gachaCatalog.ts are the catalogue source-of-truth
// for which skins exist and what they cost; this map is the client-side "which card can wear it" mirror).
// Because a skin never overlaps another skin's UnitType, equipping is naturally per-card: the old
// single global `equipped[EQUIP_SLOT]` slot is replaced by one slot per UnitType.
import { UnitType } from '@nw/engine/types';
import { t, TranslationKey } from '../../i18n';
import { CARD_DEFS } from './cardDefs';

export const SKIN_TARGET_UNIT: Record<string, UnitType> = {
  skin_shop_c1: UnitType.Infantry,
  skin_shop_r1: UnitType.Archer,
  skin_shop_e1: UnitType.ShieldBearer,
  skin_e1: UnitType.Lena,
  skin_e2: UnitType.Mara,
  skin_l1: UnitType.Max,
};

/**
 * Player-facing skin name: "{character}·{skin label}" (e.g. 李川·皮肤), resolved from the character
 * card the skin re-skins — never the raw catalogue id. Falls back to the id if the skin isn't mapped.
 * Single source of truth for skin naming across the shop grid + gacha odds/result (both call this).
 */
export function skinDisplayName(skinId: string): string {
  const unit = SKIN_TARGET_UNIT[skinId];
  if (!unit) return skinId;
  const target = Object.values(CARD_DEFS).find((d) => d.unitType === unit);
  const base = target ? t((`card.${target.id}.name`) as TranslationKey) : skinId;
  return `${base}·${t('shop.skinLabel')}`;
}

/** Owned skin ids that can be worn by the given unit type (its character). */
export function skinsForUnitType(unitType: UnitType, owned: readonly string[]): string[] {
  return owned.filter((id) => SKIN_TARGET_UNIT[id] === unitType);
}

/** The per-character equip slot key inside `SaveData.equipped` (replaces the old single EQUIP_SLOT='unit'). */
export function skinEquipKey(unitType: UnitType): string {
  return `skin:${unitType}`;
}

/** Every currently-equipped skin id (all characters), for feeding into battle rendering (UnitView.resolveAssets). */
export function allEquippedSkins(equipped: Record<string, string>): string[] {
  return Object.entries(equipped)
    .filter(([k]) => k.startsWith('skin:'))
    .map(([, v]) => v);
}

/**
 * The equipped skin id targeting `unitType`, out of a flattened battle-render skin list (as produced
 * by {@link allEquippedSkins}) — the in-match hand tray (HandView) only ever has this flattened list,
 * not the original `SaveData.equipped` map. At most one entry can target a given type (a skin never
 * overlaps another skin's UnitType, see SKIN_TARGET_UNIT's doc comment above).
 */
export function equippedSkinIdForType(unitType: UnitType, equippedSkins: readonly string[]): string | null {
  return equippedSkins.find((id) => SKIN_TARGET_UNIT[id] === unitType) ?? null;
}
