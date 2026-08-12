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
import { type Fp, toFp, addFp, scaleFp, growFp, maxFp } from '../math/fixed';

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
 *
 * ADR-065: `hp`/`attack`/`siege`/`armor` are `Fp` — they scale the now-fp-scaled
 * `hp_fp`/`attack_fp`/`siegeValue_fp`/`armor_fp` blueprint fields via `growFp`/`toFp`.
 * `atkspd`/`spd` stay plain decimals — they scale `attackInterval`/`speed`, which are
 * NOT part of ADR-065's fp conversion (see blueprints.ts field comments), so there is
 * no fp value on the other side of that multiplication to stay consistent with.
 */
export const STAT_GROWTH_PER_LEVEL = {
  hp: toFp(0.12),
  attack: toFp(0.1),
  /** siege value +10%/level (ADR-026). Mirrors SIEGE_VALUE_GROWTH_PER_LEVEL in @nw/shared cards so the engine (PvE/siege) and SLG's teamSiegeValue agree. */
  siege: toFp(0.1),
  /** Attack speed %: each level divides attack interval by (1 + atkspd×steps), clamped to a minimum to prevent frame-breaking (see applyUnitLevels). Plain decimal — see doc comment above. */
  atkspd: 0.04,
  /** Move speed %: speed × (1 + spd×steps). Plain decimal — see doc comment above. */
  spd: 0.03,
  /** Armor flat per level (additive fp). S12-E reduced: at armor:2, L9+16 made archer's 22 attack deal only 6 effective damage (73% reduction), too strong. */
  armor: toFp(1),
} as const;

/** Attack speed cap: attack interval must not fall below this ratio of the base (prevents frame-breaking; §4.2 "has minimum cap"). */
export const MIN_ATTACK_INTERVAL_RATIO = 0.5;

/**
 * Universal trait breakpoints (ECONOMY_NUMBERS §4.4 unlock table, T3/T6 shared by all progressable
 * unit types; T9 is per-unit as of 2026-08-05, see PER_UNIT_T9_TRAITS below):
 *   · T3 critical hit: critPct chance to deal ×critMult damage (multiplied before armor reduction, engine mechanic see CombatSystem).
 *   · T6 lifesteal: on hit, recover HP equal to % of actual damage dealt (additive into lifestealPct, capped across sources by clampEffectCaps ≤30).
 *   · T9 (bonusSpawn) is now only the *fallback* for units with no PER_UNIT_T9_TRAITS entry
 *     (currently just Infantry — kept generic on purpose, see PER_UNIT_T9_TRAITS doc comment).
 * Values aligned with §4.4 unlock table ([adjustable]). T3/T6 deliberately NOT differentiated per
 * unit (scope decision, 2026-08-05): both already went through PvP/PvE balance calibration as
 * universal constants, and equipment.ts's crit affix base (m_critmult) reads TRAIT_BREAKPOINTS.crit
 * directly — differentiating those two tiers would be a much larger, separate exercise.
 *
 * ADR-065: `pct`/`mult` are `Fp` (they set `critPct_fp`/`critMult_fp`/`lifestealPct_fp`).
 * `level`/`count` stay plain — `level` is a unit-level threshold (never a blueprint fp field),
 * `count` scales `spawnCount`, a discrete count field outside ADR-065's scope.
 */
export const TRAIT_BREAKPOINTS = {
  crit: { level: 3, pct: toFp(10), mult: toFp(1.5) },
  lifesteal: { level: 6, pct: toFp(15) },
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
    u.hp_fp = growFp(u.hp_fp, STAT_GROWTH_PER_LEVEL.hp, steps);
    u.attack_fp = growFp(u.attack_fp, STAT_GROWTH_PER_LEVEL.attack, steps);
    // siege value scales like attack (ADR-026): PvE/siege only — buildPvpBlueprints never calls this, so PvP keeps the base constant.
    u.siegeValue_fp = growFp(u.siegeValue_fp, STAT_GROWTH_PER_LEVEL.siege, steps);
    // Attack speed: divide by (1 + atkspd×steps), clamped to minimum ratio of base interval (prevent
    // frame-breaking). Plain decimal arithmetic — attackInterval is outside ADR-065's fp scope.
    const atkspdFactor = 1 + STAT_GROWTH_PER_LEVEL.atkspd * steps;
    u.attackInterval = Math.max(
      u.attackInterval * MIN_ATTACK_INTERVAL_RATIO,
      u.attackInterval / atkspdFactor,
    );
    // Move speed: multiplicative. Plain decimal — speed is outside ADR-065's fp scope.
    u.speed = u.speed * (1 + STAT_GROWTH_PER_LEVEL.spd * steps);
    // Armor: flat additive fp (capped across sources by clampEffectCaps at the end).
    u.armor_fp = addFp(u.armor_fp ?? toFp(0), scaleFp(steps, STAT_GROWTH_PER_LEVEL.armor));

    // ── Trait breakpoints (discrete qualitative changes) ────────────────────────────────────────────────
    if (level >= TRAIT_BREAKPOINTS.crit.level) {
      // T3 sets the base crit chance/multiplier. Runs before applyEquipment, which ADDS equipment
      // crit chance (m_crit) on top and adds s_critmult to the multiplier; the all-source sum caps
      // (§7.7① ≤50% chance, crit-damage cap) are applied uniformly in clampEffectCaps.
      u.critPct_fp = maxFp(u.critPct_fp ?? toFp(0), TRAIT_BREAKPOINTS.crit.pct);
      u.critMult_fp = maxFp(u.critMult_fp ?? toFp(1), TRAIT_BREAKPOINTS.crit.mult);
    }
    if (level >= TRAIT_BREAKPOINTS.lifesteal.level) {
      // Additive into lifestealPct, summed across sources then uniformly capped by clampEffectCaps (≤30).
      u.lifestealPct_fp = addFp(u.lifestealPct_fp ?? toFp(0), TRAIT_BREAKPOINTS.lifesteal.pct);
    }
    if (level >= TRAIT_BREAKPOINTS.bonusSpawn.level) {
      // T9 is the one tier that differs per unit (ECONOMY_NUMBERS §4.4 "后期差异化路线",
      // 2026-08-05): a unit with an entry in PER_UNIT_T9_TRAITS gets its own qualitative payoff
      // instead of the generic +1 spawn. T3 crit / T6 lifesteal above stay universal — replacing
      // those too would re-open PvP/PvE balance already calibrated around them (scope decision,
      // see ECONOMY_NUMBERS §4.4).
      const t9 = PER_UNIT_T9_TRAITS[unitType];
      if (!t9) {
        u.spawnCount = u.spawnCount + TRAIT_BREAKPOINTS.bonusSpawn.count;
      } else {
        applyUnitT9Trait(u, t9);
      }
    }
  }
}

/**
 * Per-unit T9 progression payoff (ECONOMY_NUMBERS §4.4 "后期差异化路线"). Units absent from this
 * table fall back to the generic +1 spawn (TRAIT_BREAKPOINTS.bonusSpawn) — currently only
 * Infantry, kept undifferentiated on purpose as the cp/ink=1.0 balance anchor (BALANCE.md §5.1).
 * Each variant reuses an engine mechanism that already exists and is already exercised by some
 * other unit (splashRadius/slowOnHit/aura_heal precedent) or by a same-shaped HP-threshold getter
 * (berserkerThreshold → effectiveAttackIntervalTicks), so none of these are new combat mechanics.
 */
// ADR-065: threshold/bonus/pct/mult below are `Fp` (they set fp blueprint fields);
// `amount`/`durationSec` stay plain (they set `range`/`durationSec`, outside ADR-065's scope).
export type UnitT9Trait =
  | { kind: 'rangeBonus'; amount: number }
  | { kind: 'armorEnrage'; threshold: Fp; bonus: Fp }
  | { kind: 'reflect'; pct: Fp }
  | { kind: 'slowOnHit'; mult: Fp; durationSec: number }
  | { kind: 'burstMult'; mult: Fp };

export const PER_UNIT_T9_TRAITS: Partial<Record<UnitType, UnitT9Trait>> = {
  // Archer (弓兵): range 2 → 3. Cheapest possible variant — bp.range is a plain number, no new field.
  [UnitType.Archer]: { kind: 'rangeBonus', amount: 1 },
  // ShieldBearer (重甲): armor +6 while below 40% HP. Mirrors Berserker's berserkerThreshold shape
  // (HP-fraction-gated dynamic getter) but on armor instead of attack speed.
  [UnitType.ShieldBearer]: { kind: 'armorEnrage', threshold: toFp(0.4), bonus: toFp(6) },
  // Lena (重甲/哨卫): reflect 20 % of damage taken back onto the attacker — a second "重甲" flavor
  // distinct from ShieldBearer's (punish attackers instead of just soaking more).
  [UnitType.Lena]: { kind: 'reflect', pct: toFp(20) },
  // Mara (远程/游击): arrows also apply a 20 % slow for 1.5 s — slowOnHit already exists and is
  // fully wired in CombatSystem, just unused by any unit until now.
  [UnitType.Mara]: { kind: 'slowOnHit', mult: toFp(0.8), durationSec: 1.5 },
  // Max (先锋终结者): numeric buff to his existing burstOnSingle finisher, ×2 → ×2.5.
  [UnitType.Max]: { kind: 'burstMult', mult: toFp(2.5) },
};

function applyUnitT9Trait(u: UnitBlueprint, t9: UnitT9Trait): void {
  switch (t9.kind) {
    case 'rangeBonus':
      u.range = u.range + t9.amount;
      break;
    case 'armorEnrage':
      u.armorEnrageThreshold_fp = t9.threshold;
      u.armorEnrageBonus_fp = t9.bonus;
      break;
    case 'reflect':
      u.reflectPct_fp = t9.pct;
      break;
    case 'slowOnHit':
      u.slowOnHit = { mult_fp: t9.mult, durationSec: t9.durationSec };
      break;
    case 'burstMult':
      u.burstOnSingleMult_fp = t9.mult;
      break;
  }
}
