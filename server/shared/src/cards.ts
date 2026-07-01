// Character card definitions and Hero Roster mechanics (CHARACTER_CARDS_DESIGN §2.1/§3/§9).
//
// Shared authority for card catalogue + pure progression math. No engine import allowed
// (engine bundles this via webpack alias; @nw/shared → mongodb would bloat the client bundle).
// CardDef.unitType string values must match @nw/engine UnitType enum values exactly (same
// convention as unitCards.ts PROGRESSABLE_UNIT_IDS).
//
// Numerical calibration: all DRAFT values are placeholders; authoritative destination is
// ECONOMY_NUMBERS §6. Only change constants, not the formulas (README §0 iron rule #1).

import type { CardInstance } from './types';
import type { EquipmentInstance } from './types';

/** Card faction (CHARACTER_DESIGN §1). Expandable; third faction reserved for future design. */
export type Faction = 'tao' | 'anna';

/**
 * Signature skill effect values at card levels 1–9 (index 0 = level 1; index 8 = level 9).
 * Zero = no skill effect at that level (Tao-side "baseline" cards have no signature skill at any level).
 * The engine reads these values at blueprint-generation time to set unit special fields
 * (e.g. burstOnSingle, disciplineArmor, markBonus). See CHARACTER_DESIGN §2.1/§2.2/§2.3.
 */
export type SkillGrowthTable = readonly [number, number, number, number, number, number, number, number, number];

/** Shared zero-skill table for Tao baseline cards (no signature mechanic, §1 anchor rule). */
const NO_SKILL: SkillGrowthTable = [0, 0, 0, 0, 0, 0, 0, 0, 0];

export interface CardDef {
  /** Unique character id (e.g. 'lichuang', 'max'). Stable; used as defId in CardInstance. */
  id: string;
  /**
   * Engine unit type string value (must match @nw/engine UnitType enum value exactly).
   * Infantry = 'infantry', ShieldBearer = 'shieldbearer', Archer = 'archer',
   * Max = 'max', Lena = 'lena', Mara = 'mara'.
   */
  unitType: string;
  faction: Faction;
  /** Troop capacity at level 1 (base). [DRAFT → ECONOMY_NUMBERS §6] */
  troopCapBase: number;
  /** Flat troop capacity growth per card level. [DRAFT → ECONOMY_NUMBERS §6] */
  troopCapGrowth: number;
  /** Signature skill effect values per level (CHARACTER_DESIGN §2.x). Tao-side = NO_SKILL. */
  skillGrowth: SkillGrowthTable;
  /**
   * Combat power formula weights for cardPower() (CHARACTER_CARDS_DESIGN §2.4).
   * Weights reflect each unit type's stat distribution (tank → hp-heavy; dps → atk-heavy).
   * [DRAFT → ECONOMY_NUMBERS §6]
   */
  powerWeights: { hp: number; atk: number };
}

/**
 * Card catalogue — 6 character cards across 2 factions (CHARACTER_DESIGN §1).
 * Tao side: named versions of the three base unit types, no signature skills (§1 anchor/baseline).
 * Anna side: new designs with signature skills that differentiate from Tao counterparts.
 * All numbers are DRAFT placeholders; authoritative values go in ECONOMY_NUMBERS §6.
 */
export const CARD_DEFS: Record<string, CardDef> = {
  // ── Tao faction (方家·东方) ─────────────────────────────────────────────────────────
  // Tao three = named versions of existing units; stats are unchanged from UNIT_BLUEPRINTS (§1 rule 1).
  lichuang: {
    id: 'lichuang',
    unitType: 'infantry',
    faction: 'tao',
    troopCapBase: 200,
    troopCapGrowth: 50,
    skillGrowth: NO_SKILL,
    powerWeights: { hp: 0.4, atk: 0.6 },
  },
  chenshou: {
    id: 'chenshou',
    unitType: 'shieldbearer',
    faction: 'tao',
    troopCapBase: 100,
    troopCapGrowth: 25,
    skillGrowth: NO_SKILL,
    powerWeights: { hp: 0.7, atk: 0.3 },
  },
  suyuan: {
    id: 'suyuan',
    unitType: 'archer',
    faction: 'tao',
    troopCapBase: 100,
    troopCapGrowth: 25,
    skillGrowth: NO_SKILL,
    powerWeights: { hp: 0.3, atk: 0.7 },
  },

  // ── Anna faction (Hartmann·西方) ──────────────────────────────────────────────────
  // Anna three = new designs with signature skills; stats deviate from Tao counterparts.
  // skillGrowth[level-1] = signature skill effect value at that level. [DRAFT]
  max: {
    id: 'max',
    unitType: 'max',
    faction: 'anna',
    troopCapBase: 100,
    troopCapGrowth: 25,
    // burstOnSingle: fixed bonus damage when only one enemy unit remains (CHARACTER_DESIGN §2.1)
    // Values: [L1=0, L2=0, L3=5, L4=5, L5=10, L6=10, L7=15, L8=15, L9=20]  [DRAFT]
    skillGrowth: [0, 0, 5, 5, 10, 10, 15, 15, 20],
    powerWeights: { hp: 0.4, atk: 0.6 },
  },
  lena: {
    id: 'lena',
    unitType: 'lena',
    faction: 'anna',
    troopCapBase: 100,
    troopCapGrowth: 25,
    // disciplineArmor: flat damage reduction per incoming hit (CHARACTER_DESIGN §2.2)
    // Values: [L1=0, L2=0, L3=2, L4=2, L5=4, L6=4, L7=6, L8=6, L9=8]  [DRAFT]
    skillGrowth: [0, 0, 2, 2, 4, 4, 6, 6, 8],
    powerWeights: { hp: 0.7, atk: 0.3 },
  },
  mara: {
    id: 'mara',
    unitType: 'mara',
    faction: 'anna',
    troopCapBase: 100,
    troopCapGrowth: 25,
    // markEnemies: % bonus damage all sources deal to marked targets (CHARACTER_DESIGN §2.3)
    // Values: [L1=0, L2=0, L3=10, L4=10, L5=15, L6=15, L7=20, L8=20, L9=25]  [DRAFT]
    skillGrowth: [0, 0, 10, 10, 15, 15, 20, 20, 25],
    powerWeights: { hp: 0.3, atk: 0.7 },
  },
};

// ── XP curve (CHARACTER_CARDS_DESIGN §3.1) ──────────────────────────────────────────────
//
// Formula: cost(level → level+1) = 5^level   (level 1-indexed, so L1→L2 = 5^1 = 5)
// LEVEL_CUMULATIVE_XP[k] = total XP needed to reach level k from the starting state (level 1, xp=0).
// Index 0 is unused; index 1 = 0 (level 1 is the starting state, no cost to "reach" it).
// Final: L9 cumulative ≈ 488k XP.  [DRAFT authoritative value → ECONOMY_NUMBERS §6]

export const LEVEL_CUMULATIVE_XP: readonly number[] = [
  0,       // [0] unused (no level 0)
  0,       // [1] level 1 = starting state
  5,       // [2] +5^1 = +5
  30,      // [3] +5^2 = +25
  155,     // [4] +5^3 = +125
  780,     // [5] +5^4 = +625
  3905,    // [6] +5^5 = +3125
  19530,   // [7] +5^6 = +15625
  97655,   // [8] +5^7 = +78125
  488280,  // [9] +5^8 = +390625
];

/**
 * Total "feed value" of a card instance: the XP cost that went into this card (its accumulated investment).
 * Used by the feed system: receiverXp += feedXp(material) × 0.70 (same-faction 70% efficiency; CHARACTER_CARDS_DESIGN §3.3).
 *
 * feedXp(card) = LEVEL_CUMULATIVE_XP[card.level] + card.xp
 */
export function feedXp(card: CardInstance): number {
  const level = Math.max(1, Math.min(Math.floor(card.level), 9));
  return (LEVEL_CUMULATIVE_XP[level] ?? 0) + Math.max(0, card.xp);
}

// ── Power scoring (CHARACTER_CARDS_DESIGN §2.4) ─────────────────────────────────────────
//
// cardPower is used for:
//   ① Card roster UI sort (power descending, CHARACTER_CARDS_DESIGN §10.1)
//   ② selectBestCard — PvE picks the highest-power card of the required unit type (§9)
//
// The exact power formula (hp_at_level × w_hp + atk_at_level × w_atk) × (1 + equipBonus%)
// requires the engine's UNIT_BLUEPRINTS for base stats, which @nw/shared cannot import.
// This implementation uses a level multiplier proxy (mirrors average STAT_GROWTH_PER_LEVEL
// from progression.ts) + affix-value sum for equipment bonus. The ordering is correct for
// same-unit-type comparisons; cross-unit comparison is approximate but sufficient for UI.

/** Approximate continuous stat growth at level k (average of hp+12% and atk+10% per step ≈ 11%). */
function levelStatMult(level: number): number {
  return 1 + 0.11 * (Math.max(1, Math.min(level, 9)) - 1);
}

/**
 * Relative combat power score for a card instance (CHARACTER_CARDS_DESIGN §2.4).
 * Not authoritative — the engine blueprint is authoritative for actual combat stats.
 *
 * @param card         The card instance to score.
 * @param equipmentInv SaveData.equipmentInv (resolves the gear slot instance IDs). Pass {} if unavailable.
 */
export function cardPower(
  card: CardInstance,
  equipmentInv: Record<string, EquipmentInstance>,
): number {
  const def = CARD_DEFS[card.defId];
  if (!def) return 0;
  const lv = Math.max(1, Math.min(Math.floor(card.level), 9));
  // Base power: normalized by power weights (both on 0–1 scale summing to 1) × 100 scale factor
  const basePower = (def.powerWeights.hp + def.powerWeights.atk) * 100 * levelStatMult(lv);
  // Equipment bonus: rough sum of all affix values (affix.value is in % units for primary/secondary)
  let equipBonusPct = 0;
  for (const instId of Object.values(card.gear)) {
    if (!instId) continue;
    const inst = equipmentInv[instId];
    if (!inst) continue;
    for (const affix of inst.affixes) {
      equipBonusPct += affix.value;
    }
  }
  return basePower * (1 + equipBonusPct / 100);
}

/**
 * Selects the highest-power card instance for a given unit type from the inventory.
 * Used by PvE campaign: the engine auto-deploys the best available card of the required unit type (CHARACTER_CARDS_DESIGN §9).
 *
 * @param unitType     Engine unit type string value (e.g. 'infantry', 'max').
 * @param cardInv      SaveData.cardInv (record of all card instances).
 * @param equipmentInv SaveData.equipmentInv for power scoring. Defaults to {} (ignores equipment bonus when omitted).
 * @returns The best card instance, or undefined if no card of that unit type exists.
 */
export function selectBestCard(
  unitType: string,
  cardInv: Record<string, CardInstance>,
  equipmentInv: Record<string, EquipmentInstance> = {},
): CardInstance | undefined {
  let best: CardInstance | undefined;
  let bestPower = -1;
  for (const card of Object.values(cardInv)) {
    const def = CARD_DEFS[card.defId];
    if (!def || def.unitType !== unitType) continue;
    const power = cardPower(card, equipmentInv);
    if (power > bestPower) {
      bestPower = power;
      best = card;
    }
  }
  return best;
}
