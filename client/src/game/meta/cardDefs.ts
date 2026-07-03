// Character card definitions — client-side mirror (CHARACTER_CARDS_DESIGN §2.1/§3).
//
// Mirror discipline: same as equipmentDefs.ts. No @nw/shared import (pulls in mongodb/jwt);
// only pure data needed for UI preview. CardDef.unitType values must match @nw/engine UnitType enum.
// Numerical calibration: DRAFT values — authoritative destination is ECONOMY_NUMBERS §6.

import type { CardInstance } from './SaveData';
import type { EquipmentInstance } from './SaveData';
import type { EngineCardInstance, UnitType } from '@nw/engine';

export type Faction = 'tao' | 'anna';

export type SkillGrowthTable = readonly [number, number, number, number, number, number, number, number, number];

export interface CardDef {
  id: string;
  unitType: string;
  faction: Faction;
  troopCapBase: number;
  troopCapGrowth: number;
  skillGrowth: SkillGrowthTable;
  powerWeights: { hp: number; atk: number };
}

const NO_SKILL: SkillGrowthTable = [0, 0, 0, 0, 0, 0, 0, 0, 0];

export const CARD_DEFS: Record<string, CardDef> = {
  lichuang:  { id: 'lichuang',  unitType: 'infantry',    faction: 'tao',  troopCapBase: 200, troopCapGrowth: 50, skillGrowth: NO_SKILL,                          powerWeights: { hp: 0.4, atk: 0.6 } },
  chenshou:  { id: 'chenshou',  unitType: 'shieldbearer', faction: 'tao', troopCapBase: 100, troopCapGrowth: 25, skillGrowth: NO_SKILL,                          powerWeights: { hp: 0.7, atk: 0.3 } },
  suyuan:    { id: 'suyuan',    unitType: 'archer',      faction: 'tao',  troopCapBase: 100, troopCapGrowth: 25, skillGrowth: NO_SKILL,                          powerWeights: { hp: 0.3, atk: 0.7 } },
  max:       { id: 'max',       unitType: 'max',         faction: 'anna', troopCapBase: 100, troopCapGrowth: 25, skillGrowth: [0, 0, 5, 5, 10, 10, 15, 15, 20],  powerWeights: { hp: 0.4, atk: 0.6 } },
  lena:      { id: 'lena',      unitType: 'lena',        faction: 'anna', troopCapBase: 100, troopCapGrowth: 25, skillGrowth: [0, 0, 2, 2, 4,  4,  6,  6,  8],   powerWeights: { hp: 0.7, atk: 0.3 } },
  mara:      { id: 'mara',      unitType: 'mara',        faction: 'anna', troopCapBase: 100, troopCapGrowth: 25, skillGrowth: [0, 0, 10, 10, 15, 15, 20, 20, 25], powerWeights: { hp: 0.3, atk: 0.7 } },
};

export function getCardDef(defId: string): CardDef | undefined {
  return CARD_DEFS[defId];
}

/** Hard cap on CardInstance count per account (CHARACTER_CARDS_DESIGN §2). */
export const CARD_INV_CAP = 150;

/** Warn threshold: show cap warning when > this many cards are held. */
export const CARD_INV_WARN = 140;

export const LEVEL_CUMULATIVE_XP: readonly number[] = [
  0,       // [0] unused
  0,       // [1] level 1 = starting state
  5,       // [2] +5
  30,      // [3] +25
  155,     // [4] +125
  780,     // [5] +625
  3905,    // [6] +3125
  19530,   // [7] +15625
  97655,   // [8] +78125
  488280,  // [9] +390625
];

/** Total XP value of a card (used as feed input; CHARACTER_CARDS_DESIGN §3.3). */
export function feedXp(card: CardInstance): number {
  const level = Math.max(1, Math.min(Math.floor(card.level), 9));
  return (LEVEL_CUMULATIVE_XP[level] ?? 0) + Math.max(0, card.xp);
}

/** XP required to advance from current level to next (returns Infinity at max level 9). */
export function xpToNextLevel(level: number): number {
  if (level >= 9) return Infinity;
  const next = Math.pow(5, Math.max(1, level));
  return next;
}

/** Troop capacity for a card at a given level. */
export function troopCap(card: CardInstance): number {
  const def = CARD_DEFS[card.defId];
  if (!def) return 0;
  const lv = Math.max(1, Math.min(Math.floor(card.level), 9));
  return def.troopCapBase + def.troopCapGrowth * (lv - 1);
}

/** Approximate combat power score (CHARACTER_CARDS_DESIGN §2.4). Same proxy formula as server/shared/src/cards.ts. */
export function cardPower(card: CardInstance, equipmentInv: Record<string, EquipmentInstance> = {}): number {
  const def = CARD_DEFS[card.defId];
  if (!def) return 0;
  const lv = Math.max(1, Math.min(Math.floor(card.level), 9));
  const basePower = (def.powerWeights.hp + def.powerWeights.atk) * 100 * (1 + 0.11 * (lv - 1));
  let equipBonusPct = 0;
  for (const instId of Object.values(card.gear)) {
    if (!instId) continue;
    const inst = equipmentInv[instId];
    if (!inst) continue;
    for (const affix of inst.affixes) equipBonusPct += affix.value;
  }
  return basePower * (1 + equipBonusPct / 100);
}

/**
 * Convert the Hero Roster (SaveData.cardInv) into the engine's card-instance shape
 * (CHARACTER_CARDS_DESIGN §9) for the PvE battle path: resolves each card's unitType
 * from its defId (via CARD_DEFS) and forwards level + gear. The engine picks the
 * highest-level card per unit type to build the campaign/siege blueprint, and the
 * battle-render gear overlay (UnitView) mirrors that same selection so the drawn gear
 * matches the applied stats. PvP never calls this (hard wall — buildPvpBlueprints has
 * no card parameter, so card progression / equipment cannot leak into ladder/duel).
 */
export function toEngineCardInstances(
  cardInv: Record<string, CardInstance> | undefined,
): EngineCardInstance[] {
  const out: EngineCardInstance[] = [];
  for (const card of Object.values(cardInv ?? {})) {
    const def = CARD_DEFS[card.defId];
    if (!def) continue; // unknown defId (forward-compat): skip
    out.push({
      id: card.id,
      defId: card.defId,
      unitType: def.unitType as UnitType,
      level: card.level,
      gear: card.gear,
    });
  }
  return out;
}
