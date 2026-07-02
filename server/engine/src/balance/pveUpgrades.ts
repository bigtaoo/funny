// PvE progression — upgrade tree + fairness hard wall (META_DESIGN.md §5).
//
// Three blueprint construction paths, physically isolating PvE combat power from PvP fairness:
//   · buildPvpBlueprints()                    — read-only constants; SaveData / card data never appear in its signature.
//   · buildCampaignBlueprints(cards, inv)     — CC-1: card instance array → level injection + per-card equipment.
//   · buildSiegeBlueprints(cards, inv, acad)  — same as campaign + optional academy seasonal buff.
// Hard-wall unit test (hardwall.test.ts): with max-level cards, buildPvpBlueprints() still equals UNIT_BLUEPRINTS byte-for-byte.
//
// applyPveUpgrades (old upgrade tree) is retained for the deprecated SaveData.pveUpgrades field
// but is no longer called by the builder functions — card level (applyUnitLevels) replaces it.

import { UNIT_BLUEPRINTS } from '../config';
import { UnitType, type UnitBlueprint } from '../types';
import { applyEquipment, clampEffectCaps, type EngineCardInstance, type EngineEquipInv } from './equipment';
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
 * P4 (client/test/pvpSim.ts) validated the values below; the override stays minimal.
 */
export function buildPvpBlueprints(): Record<UnitType, UnitBlueprint> {
  const bp = cloneBlueprints();

  // Medic PvP override (P4-finalized): a token melee poke so it is not a passive
  // punching bag — attack 4 / interval 1.2 / range 1 (DPS ≈ 3.3). The PvP duel sim
  // showed the Medic is non-oppressive at cost 6 (≈27% equal-ink, and adding one to
  // an army does not tip a stomp), so the aura (8 HP/s, radius 2) is left untouched.
  bp[UnitType.Medic].attack         = 4;
  bp[UnitType.Medic].attackInterval = 1.2;
  bp[UnitType.Medic].range          = 1;

  // Harpy PvP: cost=7 (CARD_DEFINITIONS) is the sole balance lever — no blueprint
  // change. P4 resolved the §5 deferred question: the sim shows Harpy is never
  // oppressive (a bypassing flyer can't win the blob trade and 6-at-cost-7 lose the
  // base race), so NO extra flying counter-play mechanic is added. The ≥1-building
  // class floor (tower is 1 of only 2 buildings) keeps it answerable in practice.

  return bp;
}

/**
 * Campaign path (CC-1): card instances → level injection → per-card equipment → cap (CHARACTER_CARDS_DESIGN §9).
 * For each progressable unit type, the highest-level card is selected; its level drives applyUnitLevels,
 * and its equipment drives applyEquipment. Multiple cards of the same type are ignored beyond the best one
 * (PvE deploys one unit per type; SLG multi-card support comes in a later CC phase).
 *
 * @param cardInstances Player's card instances (SaveData.cardInv values, with unitType resolved).
 * @param equipmentInv  Full equipment inventory (SaveData.equipmentInv) for gear slot lookups. Optional: no equipment if omitted.
 */
export function buildCampaignBlueprints(
  cardInstances: EngineCardInstance[],
  equipmentInv?: EngineEquipInv,
): Record<UnitType, UnitBlueprint> {
  const bp = cloneBlueprints();
  // Derive unit levels and best-card-per-type from the card array.
  const bestCards = new Map<UnitType, EngineCardInstance>();
  for (const card of cardInstances) {
    const cur = bestCards.get(card.unitType);
    if (!cur || card.level > cur.level) bestCards.set(card.unitType, card);
  }
  const unitLevels: Record<string, number> = {};
  for (const [unitType, card] of bestCards) unitLevels[unitType] = card.level;
  applyUnitLevels(bp, unitLevels);
  if (equipmentInv) {
    for (const card of bestCards.values()) applyEquipment(bp, card, equipmentInv);
  }
  clampEffectCaps(bp);
  return bp;
}

/**
 * SLG siege path (S8-3, SLG_DESIGN §5.2 / §6.2, CC-1 adapted): same injection chain as campaign.
 * Separate name serves two purposes:
 *   ① Express the "ranked red line" at the type level (siege uses this; netplay/pvp always uses buildPvpBlueprints,
 *     whose signature has no card/upgrade parameter → contamination impossible at compile time);
 *   ② Reserve a single injection point for future SLG-exclusive buffs (tech/guild bonuses not affecting PvE).
 *
 * @param cardInstances  Attacker's card instances (server-authoritative snapshot).
 * @param equipmentInv   Attacker's equipment inventory for gear lookups. Optional.
 * @param siegeAcademy   Academy building seasonal buff (SLG_CITY_DESIGN P2): fractional hp/damage/siege bonuses
 *                       applied after clampEffectCaps as a post-cap layer. Ignored on other paths.
 */
export function buildSiegeBlueprints(
  cardInstances: EngineCardInstance[],
  equipmentInv?: EngineEquipInv,
  siegeAcademy?: { hp: number; damage: number; siege: number },
): Record<UnitType, UnitBlueprint> {
  const bp = buildCampaignBlueprints(cardInstances, equipmentInv);
  if (siegeAcademy && (siegeAcademy.hp > 0 || siegeAcademy.damage > 0 || siegeAcademy.siege > 0)) {
    for (const unit of Object.values(bp) as UnitBlueprint[]) {
      if (siegeAcademy.hp > 0) unit.hp = Math.round(unit.hp * (1 + siegeAcademy.hp));
      if (siegeAcademy.damage > 0) unit.attack = Math.round(unit.attack * (1 + siegeAcademy.damage));
      // Siege value gets its own academy channel (ADR-026 "待接"): mirrors attack, on the siege path only.
      if (siegeAcademy.siege > 0) unit.siegeValue = Math.round(unit.siegeValue * (1 + siegeAcademy.siege));
    }
  }
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
