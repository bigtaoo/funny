// Unit progression — single level model (DECISIONS §unit progression / ECONOMY_NUMBERS §4).
//
// Design decision (DECISIONS:55-56): each unit type has one level 1–9 (5 level-N cards merge into 1 level-N+1, card collection sink),
// each level continuously scales stats (HP/attack/…), with discrete "unit progression traits" unlocked at T3/T6/T9.
//
// This module is the sole injection point for "unit level → blueprint", co-located with equipment.ts, same style (in-place blueprint mutation).
// Physical isolation of the PvP fairness hard line (L1): applyUnitLevels is only called by buildCampaign/buildSiegeBlueprints;
// buildPvpBlueprints() signature never takes a level parameter → compile-time guarantee of no cross-contamination (hardwall unit test guards this).
//
// Value calibration: all coefficients below are DRAFT [adjustable]; authoritative endpoint is ECONOMY_NUMBERS §4.
// This file provides runnable placeholder values; when tuning, only change constants, not mechanisms (README §0 three iron rules: values live in code).

import { UnitType, type UnitBlueprint } from '../types';

/** Maximum unit progression level (DECISIONS §unit progression: level 9, exponential card-collection sink). */
export const UNIT_MAX_LEVEL = 9;

/**
 * Progressable unit types = all card-issuing unit types in the player roster (CC-1, CHARACTER_CARDS_DESIGN §2).
 * Three Tao (Infantry/ShieldBearer/Archer) + three Anna (Max/Lena/Mara).
 * PvE-exclusive enemy types (Ironclad/Runner/Harpy/Medic/Berserker/Splitter) have no cards → not progressable.
 * Must stay in sync with PLAYER_EQUIPPABLE_UNITS in equipment.ts and CARD_DEFS in @nw/shared/cards.
 */
export const PROGRESSABLE_UNITS: readonly UnitType[] = [
  UnitType.Infantry,
  UnitType.ShieldBearer,
  UnitType.Archer,
  UnitType.Max,
  UnitType.Lena,
  UnitType.Mara,
];

/**
 * Per-level continuous stat growth (ECONOMY_NUMBERS §4.2, additive stacking per level, relative to base blueprint).
 *   multiplier = 1 + perLevel × (level − 1)   —— L1 = base (no bonus), L9 = 1 + perLevel×8.
 *   armor is flat: armor += armorPerLevel × (level − 1).
 * Values aligned per §4.2 table ([adjustable], tuning changes only here):
 *   HP +12%/level (→T9 +96%), attack +10% (→+80%), attack speed +4% (attack interval↓, →+32%),
 *   move speed +3% (→+24%), armor +2 flat/level (→+16).
 */
export const STAT_GROWTH_PER_LEVEL = {
  hp: 0.12,
  attack: 0.1,
  /** Attack speed %: each level divides attack interval by (1 + atkspd×steps), clamped to a minimum to prevent frame-breaking (see applyUnitLevels). */
  atkspd: 0.04,
  /** Move speed %: speed × (1 + spd×steps). */
  spd: 0.03,
  /** Armor flat per level (additive). S12-E reduced: at armor:2, L9+16 made archer's 22 attack deal only 6 effective damage (73% reduction), too strong. */
  armor: 1,
} as const;

/** Attack speed cap: attack interval must not fall below this ratio of the base (prevents frame-breaking; §4.2 "has minimum cap"). */
export const MIN_ATTACK_INTERVAL_RATIO = 0.5;

/**
 * Universal trait breakpoints (ECONOMY_NUMBERS §4.4 unlock table, classic three tiers T3/T6/T9, shared by all progressable unit types):
 *   · T3 critical hit: critPct chance to deal ×critMult damage (multiplied before armor reduction, engine mechanic see CombatSystem).
 *   · T6 lifesteal: on hit, recover HP equal to % of actual damage dealt (additive into lifestealPct, capped across sources by clampEffectCaps ≤30).
 *   · T9 +1 spawn: spawnCount += count (GameEngine reads parsed blueprint at card play).
 * Values aligned with §4.4 unlock table ([adjustable]), per-unit differentiation to be added later (DECISIONS:61).
 */
export const TRAIT_BREAKPOINTS = {
  crit: { level: 3, pct: 10, mult: 1.5 },
  lifesteal: { level: 6, pct: 15 },
  bonusSpawn: { level: 9, count: 1 },
} as const;

/** Clamp unit level to [1, UNIT_MAX_LEVEL] (unknown/0/negative → 1, above max → capped). */
export function clampUnitLevel(level: number | undefined): number {
  if (!Number.isFinite(level as number)) return 1;
  return Math.max(1, Math.min(Math.floor(level as number), UNIT_MAX_LEVEL));
}

/**
 * Applies unit progression levels to blueprints in-place via multiplicative scaling and breakpoint traits. The sole "level → blueprint" injection point.
 * Unknown unit id / absent / L1 are all safely no-op (forward compatible + level cannot be below 1).
 *
 * @param bp     Blueprint table (intermediate state: after clone, before applyEquipment).
 * @param levels Unit level mapping (UnitType → 1..9); absent/empty = all L1 = no bonus.
 */
export function applyUnitLevels(
  bp: Record<UnitType, UnitBlueprint>,
  levels: Record<string, number> | undefined,
): void {
  if (!levels) return;
  for (const unitType of PROGRESSABLE_UNITS) {
    const level = clampUnitLevel(levels[unitType]);
    if (level <= 1) continue; // L1 = base, no bonus

    const u = bp[unitType];

    // ── Continuous stat growth (§4.2, additive per level) ────────────────────────────────────
    const steps = level - 1;
    u.hp = Math.round(u.hp * (1 + STAT_GROWTH_PER_LEVEL.hp * steps));
    u.attack = Math.round(u.attack * (1 + STAT_GROWTH_PER_LEVEL.attack * steps));
    // Attack speed: divide by (1 + atkspd×steps), clamped to minimum ratio of base interval (prevent frame-breaking).
    const atkspdFactor = 1 + STAT_GROWTH_PER_LEVEL.atkspd * steps;
    u.attackInterval = Math.max(
      u.attackInterval * MIN_ATTACK_INTERVAL_RATIO,
      u.attackInterval / atkspdFactor,
    );
    // Move speed: multiplicative.
    u.speed = u.speed * (1 + STAT_GROWTH_PER_LEVEL.spd * steps);
    // Armor: flat additive (capped across sources by clampEffectCaps at the end).
    u.armor = (u.armor ?? 0) + STAT_GROWTH_PER_LEVEL.armor * steps;

    // ── Trait breakpoints (discrete qualitative changes) ────────────────────────────────────────────────
    if (level >= TRAIT_BREAKPOINTS.crit.level) {
      // T3 sets the base crit chance/multiplier. Runs before applyEquipment, which ADDS equipment
      // crit chance (m_crit) on top and adds s_critmult to the multiplier; the all-source sum caps
      // (§7.7① ≤50% chance, crit-damage cap) are applied uniformly in clampEffectCaps.
      u.critPct = Math.max(u.critPct ?? 0, TRAIT_BREAKPOINTS.crit.pct);
      u.critMult = Math.max(u.critMult ?? 1, TRAIT_BREAKPOINTS.crit.mult);
    }
    if (level >= TRAIT_BREAKPOINTS.lifesteal.level) {
      // Additive into lifestealPct, summed across sources then uniformly capped by clampEffectCaps (≤30).
      u.lifestealPct = (u.lifestealPct ?? 0) + TRAIT_BREAKPOINTS.lifesteal.pct;
    }
    if (level >= TRAIT_BREAKPOINTS.bonusSpawn.level) {
      u.spawnCount = u.spawnCount + TRAIT_BREAKPOINTS.bonusSpawn.count;
    }
  }
}
