// UnitView's equipment-overlay glyph resolution (§20.4), extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛"). gearSpecCache is a plain readonly Map
// reference (mutated in place via .set, never reassigned) — no getter/setter needed.
import { Side } from '@nw/engine/types';
import type { Unit } from '@nw/engine/Unit';
import type { UnitType } from '@nw/engine/types';
import { PLAYER_EQUIPPABLE_UNITS } from '@nw/engine';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { getEquipDef } from '../../game/meta/equipmentDefs';
import type { EquipSlot } from '../../game/meta/SaveData';
import type { StickmanRuntime } from '../stickman/StickmanRuntime';
import type { GearGlyphSpec } from '../stickman/StickmanRuntime';

export interface GearHost {
  readonly localSide: Side;
  readonly cardInstances: EngineCardInstance[] | null;
  readonly equipmentInv: EngineEquipInv | null;
  readonly gearSpecCache: Map<UnitType, GearGlyphSpec[]>;
}

/**
 * Resolve the equipment overlay glyphs for a unit type (§20.4): mirror
 * buildCampaignBlueprints (CC-1) by picking the highest-level card of this unit type,
 * then reading its per-card gear → each slot's instance → defId → {slot, rarity}.
 * Using the same best-card selection the engine uses keeps the drawn gear consistent
 * with the affixes actually applied to stats. Restricted to PLAYER_EQUIPPABLE_UNITS.
 * Memoized — gear is constant per match. Returns [] when there's no card/equipment
 * data (PvP) or nothing worn.
 */
export function gearSpecsFor(host: GearHost, unitType: UnitType): GearGlyphSpec[] {
  const cached = host.gearSpecCache.get(unitType);
  if (cached) return cached;

  const specs: GearGlyphSpec[] = [];
  const cards = host.cardInstances;
  const inv = host.equipmentInv;
  if (cards && inv && (PLAYER_EQUIPPABLE_UNITS as readonly UnitType[]).includes(unitType)) {
    let best: EngineCardInstance | undefined;
    for (const c of cards) {
      if (c.unitType !== unitType) continue;
      if (!best || c.level > best.level) best = c;
    }
    if (best) {
      for (const slot of ['weapon', 'armor', 'trinket'] as EquipSlot[]) {
        const instId = best.gear[slot];
        if (!instId) continue;
        const inst = inv[instId];
        if (!inst) continue;
        const def = getEquipDef(inst.defId);
        if (!def) continue;
        specs.push({ slot: def.slot, rarity: def.rarity });
      }
    }
  }
  host.gearSpecCache.set(unitType, specs);
  return specs;
}

/**
 * Reconcile a runtime's equipment overlay (§20.4) to the unit it's now driving.
 * The player's own army wears their loadout (§8); a same-type *enemy* shows none
 * (its empty key clears any stale decals from a prior local-side life — pools are
 * keyed by type, not side, so a runtime can flip sides on reuse). setGear is
 * idempotent, so the common pooled-reuse-same-side case is a no-op.
 */
export function applyGear(host: GearHost, runtime: StickmanRuntime, unit: Unit): void {
  runtime.setGear(unit.side === host.localSide ? gearSpecsFor(host, unit.unitType) : []);
}
