// Skin ↔ character binding (LOBBY_IA_REDESIGN §15 / ADR-038). Each ownable skin re-skins exactly one
// UnitType (server/shared/src/economy.ts SHOP_SKINS + gachaCatalog.ts are the catalogue source-of-truth
// for which skins exist and what they cost; this map is the client-side "which card can wear it" mirror).
// Because a skin never overlaps another skin's UnitType, equipping is naturally per-card: the old
// single global `equipped[EQUIP_SLOT]` slot is replaced by one slot per UnitType.
import { UnitType } from '../types';

export const SKIN_TARGET_UNIT: Record<string, UnitType> = {
  skin_shop_c1: UnitType.Infantry,
  skin_shop_r1: UnitType.Archer,
  skin_shop_e1: UnitType.ShieldBearer,
  skin_e1: UnitType.Lena,
  skin_e2: UnitType.Mara,
  skin_l1: UnitType.Max,
};

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
