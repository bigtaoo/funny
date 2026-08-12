// Pure equipment-domain helper functions for the EquipmentScene composition (see ../EquipmentScene.ts
// assembly and ./core.ts's file-header comment) — form① free functions with no Core delegate methods
// and no dependency on Core state (unlike layout.ts's grid math, these operate purely on SaveData/
// EquipmentInstance params), split out of core.ts purely to keep it under the 500-line convention
// (claudedocs/client-modules.md's split-form priority note). Every caller (core.ts, and each domain
// class) imports directly from here rather than going through a `core.xxx()` wrapper.
import { t, type TranslationKey } from '../../i18n';
import type { SaveData, EquipmentInstance } from '../../game/meta/SaveData';
import { affixKind, EQUIP_MAX_LEVEL, type EnhanceCost } from '../../game/meta/equipmentDefs';
import { enhanceMultiplier } from '@nw/engine/balance/equipment';
import { fromFp } from '@nw/engine/math/fixed';
import { levelStarsText } from '../../render/levelStars';
import { SLOTS } from './layout';

export function itemName(defId: string): string {
  const key = `equip.${defId}.name` as TranslationKey;
  const s = t(key);
  return s === key ? defId : s;
}

/** Item name + enhance level as text stars, e.g. "Marker ★★★" — omits stars entirely at level 0 (the
 *  vast majority of items, and printing a bare "+0" everywhere was pure noise). Used only where the
 *  label is embedded in a translated sentence; standalone item cards use Core.buildLevelStars() for
 *  real gold-icon stars instead. */
export function itemLabel(defId: string, level: number): string {
  const stars = levelStarsText(level, EQUIP_MAX_LEVEL);
  return stars ? `${itemName(defId)} ${stars}` : itemName(defId);
}

/** Affix description: i18n `affix.<id>` template with {v}; main affixes are scaled up by level. */
export function affixDesc(id: string, value: number, level: number): string {
  // ADR-065: enhanceMultiplier() now returns an fp value (e.g. 5000 for ×5.00); `value` here is the
  // raw affix value from SaveData (never itself fp — this preview path is independent of the engine's
  // blueprint-bake pipeline), so fromFp() unscales the multiplier back to a plain decimal before the
  // ordinary multiplication. Without this, `value * enhanceMultiplier(level)` would silently be 1000×
  // too large — it still type-checks (Fp is structurally a `number`), so nothing would flag it.
  const shown = affixKind(id) === 'main'
    ? Math.round(value * fromFp(enhanceMultiplier(level)))
    : value;
  const key = `affix.${id}` as TranslationKey;
  const s = t(key, { v: shown });
  return s === key ? `${id} +${shown}` : s;
}

export function materialsStr(mats: Record<string, number>): string {
  return Object.entries(mats)
    .map(([m, n]) => `${t(`material.${m}` as TranslationKey)}×${n}`)
    .join(' ');
}

/** Collect all equipment instance ids currently worn across ALL card instances (CC-1). */
export function equippedIds(save: SaveData): Set<string> {
  const ids = new Set<string>();
  for (const card of Object.values(save.cardInv ?? {})) {
    for (const slot of SLOTS) {
      const id = card.gear[slot];
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * All instance ids sharing `inst`'s defId+rarity that the inventory grid merges into the same
 * stacked cell (mirrors InventoryPanel.buildDisplayEntries: +0, unequipped, unlocked only —
 * everything else is always its own row). Used by the detail modal to offer a "salvage all"
 * action for the whole stack instead of just the one representative instance it was opened with.
 */
export function stackSiblingIds(save: SaveData, inst: EquipmentInstance): string[] {
  if (inst.level !== 0 || inst.locked) return [inst.id];
  const equipped = equippedIds(save);
  if (equipped.has(inst.id)) return [inst.id];
  return Object.values(save.equipmentInv)
    .filter(x => !equipped.has(x.id) && !x.locked && x.level === 0 && x.defId === inst.defId && x.rarity === inst.rarity)
    .map(x => x.id);
}

export function canAffordMaterials(save: SaveData, cost: Record<string, number>): boolean {
  return Object.entries(cost).every(([m, n]) => (save.materials[m] ?? 0) >= n);
}

export function canAffordEnhance(save: SaveData, cost: EnhanceCost): boolean {
  return canAffordMaterials(save, cost.materials) && save.wallet.coins >= cost.coins;
}
