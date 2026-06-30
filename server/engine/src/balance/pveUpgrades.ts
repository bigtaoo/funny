// PvE progression — upgrade tree + fairness hard wall (META_DESIGN.md §5).
//
// Two blueprint construction paths, physically isolating PvE combat power from PvP fairness:
//   · buildPvpBlueprints()        — read-only constants; SaveData / upgrade data never appear in its signature.
//   · buildCampaignBlueprints(lv) — constant clone + applyPveUpgrades (the single injection point).
// Hard-wall unit test (test/hardwall.test.ts): with max-level upgrades, buildPvpBlueprints() still equals UNIT_BLUEPRINTS byte-for-byte.
//
// Upgrades only modify unit stats (hp/damage/speed); buildings and skins are untouched (skins are pure render layer).
// Materials = level drops (not currency, M6), spent on upgrades; unreachable from ranked → no heavyweight anti-cheat needed (§2).

import { UNIT_BLUEPRINTS } from '../config';
import { UnitType, type UnitBlueprint } from '../types';
import { applyEquipment, clampEffectCaps, type EngineEquipmentInput } from './equipment';
import { applyUnitLevels } from './progression';

// ── Materials (level drops, PvE upgrade currency) ─────────────────────────────────────────────
//
// Three material tiers themed around notebooks. Values are DRAFT (ECONOMY_BALANCE.md §5, pending playtesting).

export const MATERIALS = {
  /** Scrap — common drop, primary material for low-tier upgrades. */
  scrap: 'scrap',
  /** Lead — mid-tier drop. */
  lead: 'lead',
  /** Binding — rare drop, used for high-tier upgrades. */
  binding: 'binding',
} as const;

export type MaterialId = (typeof MATERIALS)[keyof typeof MATERIALS];

/** Display-order material metadata (names via i18n key, icon colors provided by the render layer). */
export const MATERIAL_ORDER: MaterialId[] = [MATERIALS.scrap, MATERIALS.lead, MATERIALS.binding];

// ── Upgrade definitions ────────────────────────────────────────────────────────────────

export interface PveUpgradeDef {
  /** Stable id, used as the key in SaveData.pveUpgrades. */
  id: string;
  unitType: UnitType;
  stat: 'hp' | 'damage' | 'speed';
  maxLevel: number;
  /** +x per level (fractional; multiplicatively stacked on the base value: mult = 1 + effectPerLevel × level). */
  effectPerLevel: number;
  /** Material consumed by this upgrade. */
  material: MaterialId;
  /** Material cost for level n→n+1 = baseCost × (n+1) (linearly increasing sink). */
  baseCost: number;
}

/**
 * Upgrade tree. Three player unit types (Infantry / ShieldBearer / Archer), each with one HP line and one Damage line.
 * PvE-exclusive enemy types (Ironclad / Runner) have no upgrades (they are not in the player roster). Values are DRAFT.
 */
export const PVE_UPGRADE_DEFS: PveUpgradeDef[] = [
  // Infantry
  { id: 'inf_hp',   unitType: UnitType.Infantry,     stat: 'hp',     maxLevel: 5, effectPerLevel: 0.10, material: MATERIALS.scrap, baseCost: 3 },
  { id: 'inf_dmg',  unitType: UnitType.Infantry,     stat: 'damage', maxLevel: 5, effectPerLevel: 0.10, material: MATERIALS.scrap, baseCost: 3 },
  // ShieldBearer
  { id: 'shd_hp',   unitType: UnitType.ShieldBearer, stat: 'hp',     maxLevel: 5, effectPerLevel: 0.12, material: MATERIALS.lead,  baseCost: 2 },
  { id: 'shd_dmg',  unitType: UnitType.ShieldBearer, stat: 'damage', maxLevel: 5, effectPerLevel: 0.10, material: MATERIALS.lead,  baseCost: 2 },
  // Archer
  { id: 'arc_dmg',  unitType: UnitType.Archer,       stat: 'damage', maxLevel: 5, effectPerLevel: 0.12, material: MATERIALS.binding, baseCost: 1 },
  { id: 'arc_hp',   unitType: UnitType.Archer,       stat: 'hp',     maxLevel: 5, effectPerLevel: 0.10, material: MATERIALS.binding, baseCost: 1 },
];

/** Looks up an upgrade definition by id. */
export function getUpgradeDef(id: string): PveUpgradeDef | undefined {
  return PVE_UPGRADE_DEFS.find((d) => d.id === id);
}

/**
 * Material cost to upgrade from currentLevel to currentLevel+1; returns null if already at max level.
 */
export function upgradeCost(
  def: PveUpgradeDef,
  currentLevel: number,
): { material: MaterialId; amount: number } | null {
  if (currentLevel >= def.maxLevel) return null;
  return { material: def.material, amount: def.baseCost * (currentLevel + 1) };
}

// ── Blueprint construction (hard wall) ─────────────────────────────────────────────────────────

/** Deep-clones UNIT_BLUEPRINTS (each blueprint contains only primitive fields, so a shallow copy provides sufficient independence). */
function cloneBlueprints(): Record<UnitType, UnitBlueprint> {
  const out = {} as Record<UnitType, UnitBlueprint>;
  for (const key of Object.keys(UNIT_BLUEPRINTS) as UnitType[]) {
    out[key] = { ...UNIT_BLUEPRINTS[key] };
  }
  return out;
}

/**
 * PvP / netplay path: clones read-only constants, with no upgrade source anywhere in the signature → contamination is impossible at compile time.
 * Paired with test/hardwall.test.ts: with max-level SaveData the result still equals UNIT_BLUEPRINTS byte-for-byte.
 *
 * PvP-exclusive overrides (PVP_LOADOUT_DESIGN §5) are applied here and ONLY here —
 * they are separate from PvE numbers which live in UNIT_BLUEPRINTS.
 * TODO P4: validate all override values via difficultySim before shipping.
 */
export function buildPvpBlueprints(): Record<UnitType, UnitBlueprint> {
  const bp = cloneBlueprints();

  // Medic PvP override: add a token melee attack so it is not a passive punching bag.
  // Direction: attack≈4 / interval1.2 / range1. Exact values pending P4 sim.
  bp[UnitType.Medic].attack         = 4;
  bp[UnitType.Medic].attackInterval = 1.2;
  bp[UnitType.Medic].range          = 1;

  // Harpy PvP override: cost=7 is the balance lever (PVP_LOADOUT_DESIGN §5).
  // No blueprint stat change needed — the high cost is enforced via CARD_DEFINITIONS.
  // Flying-unit counter-play deferred to P4.

  return bp;
}

/**
 * Campaign path: constant clone + three-step injection chain (EQUIPMENT_DESIGN §9):
 *   applyPveUpgrades (unit progression/traits) → applyEquipment (equipment affixes) → clampEffectCaps (cross-source cap).
 * @param levels SaveData.pveUpgrades (upgrade id → level).
 * @param equip  Equipped gear + instance inventory (SaveData.gear + equipmentInv); defaults to no equipment, reducing the chain to upgrades only.
 */
export function buildCampaignBlueprints(
  levels: Record<string, number>,
  equip?: EngineEquipmentInput,
  unitLevels?: Record<string, number>,
): Record<UnitType, UnitBlueprint> {
  const bp = cloneBlueprints();
  applyPveUpgrades(bp, levels);
  applyUnitLevels(bp, unitLevels);
  applyEquipment(bp, equip);
  clampEffectCaps(bp);
  return bp;
}

/**
 * SLG siege path (S8-3, SLG_DESIGN §5.2 / §6.2): shares the same progression tree and injection point as campaign
 * (equipment earned in PvE directly contributes to SLG combat power). Currently equivalent to buildCampaignBlueprints word-for-word;
 * the separate name serves two purposes:
 *   ① Express the "ranked red line" at the type level (siege uses this; netplay/pvp always uses buildPvpBlueprints,
 *     whose signature has no upgrade parameter → contamination impossible at compile time, §6.1 hard-wall test still guards it);
 *   ② Reserve a single injection point for future SLG-exclusive buffs (tech/guild bonuses that do not affect PvE).
 * @param levels Server-authoritative pveUpgrades (upgrade id → level).
 * @param equip  Equipment from the attacker's authoritative progression snapshot (SaveData.gear + equipmentInv); passed in with the snapshot during server siege re-computation
 *               (EQUIPMENT_DESIGN §10: client-side tampering with local loadout cannot change "whether this loadout can breach the city"). Defaults to no equipment.
 */
export function buildSiegeBlueprints(
  levels: Record<string, number>,
  equip?: EngineEquipmentInput,
  unitLevels?: Record<string, number>,
): Record<UnitType, UnitBlueprint> {
  const bp = cloneBlueprints();
  applyPveUpgrades(bp, levels);
  applyUnitLevels(bp, unitLevels);
  applyEquipment(bp, equip);
  clampEffectCaps(bp);
  return bp;
}

/**
 * Applies upgrade levels as multiplicative modifiers to blueprints (in-place mutation). Unknown id / level 0 / above maxLevel are all safely clamped.
 * The single SaveData→blueprint injection point (§5.2).
 */
export function applyPveUpgrades(
  bp: Record<UnitType, UnitBlueprint>,
  levels: Record<string, number>,
): void {
  for (const def of PVE_UPGRADE_DEFS) {
    const lvl = Math.max(0, Math.min(levels[def.id] ?? 0, def.maxLevel));
    if (lvl === 0) continue;
    const mult = 1 + def.effectPerLevel * lvl;
    const u = bp[def.unitType];
    switch (def.stat) {
      case 'hp':
        u.hp = Math.round(u.hp * mult);
        break;
      case 'damage':
        u.attack = Math.round(u.attack * mult);
        break;
      case 'speed':
        u.speed = u.speed * mult;
        break;
    }
  }
}
