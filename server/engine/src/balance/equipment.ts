// Equipment → blueprint injection (EQUIPMENT_DESIGN §9 / §7, E1).
//
// This is the authoritative site for "affix → engine field mapping + multiplicative/additive
// arithmetic + cross-system caps" (equipment.ts §0 and EQUIPMENT_DESIGN §16 both point here,
// @nw/engine/balance/equipment.ts). Same layer and same injection style as pveUpgrades.ts
// (mutating blueprints in-place); physically isolates the PvP fairness hard line (L1):
//   · applyEquipment is only called by buildCampaignBlueprints / buildSiegeBlueprints;
//   · buildPvpBlueprints() signature never has an equipment parameter → impossible to leak
//     equipment into PvP at compile time (guarded by hardwall unit tests).
//
// ── Zero-dependency hard line (critical architecture constraint) ──────────────────────────
// The client webpack directly alias-bundles @nw/engine **source** (client/webpack.config.js),
// but @nw/shared depends on mongodb/jsonwebtoken. Therefore this module must NEVER import
// @nw/shared — otherwise mongodb would end up in the browser bundle. Equipment "instance
// types + defId registry" lives in @nw/shared (types.ts / equipment.ts); this module accepts
// **structurally equivalent local input types** instead, and callers pass shared's
// EquipmentInstance / GearLoadout directly (TS structural subtyping — extra fields are harmless).
//
// ── Numeric calibration ──────────────────────────────────────────────────────────────
// All coefficients/caps below are DRAFT [tunable]; the authoritative numeric destination is
// ECONOMY_NUMBERS §5 (not yet written). This file provides runnable placeholder values;
// when tuning, only touch these constants — never the mechanics
// (README §0 three iron rules: numbers live in code).

import { UnitType, type UnitBlueprint } from '../types';
import { TRAIT_BREAKPOINTS } from './progression';

// ── Affix id vocabulary (EQUIPMENT_DESIGN §7.4 / §7.5 / §7.6) ──────────────────────
//
// Affix ids are self-describing via namespace prefixes for "primary / secondary / skill";
// the engine uses the prefix to determine behavior — no additional marker field is needed
// on the instance (E0's EquipmentInstance.affixes is a flat Affix[]):
//   · m_*  Primary affix: always exactly 1 per item, **the only one scaled by enhancement
//          level** (§7.3). The instance stores the +0 base value;
//          engine computes effective = base × (1 + ENHANCE_COEFF_PER_LEVEL × level).
//   · s_*  Secondary affix: only on rare/epic items, **fixed at its rolled value**,
//          does not scale with enhancement (engine uses the raw value).
//   · k_*  Skill/proc: epic only, trigger-based proc (§7.6). **The proc framework is not
//          yet implemented** (FirstBlade/Lifethirst/Echo… require on-kill/on-spawn/on-hit
//          hooks, §15 pending evaluation) → engine currently **recognises but no-ops** these,
//          leaving blueprints unaffected (implementation is independent work after E1, not
//          part of this slice).
//   · Unknown id: silently ignored (forward-compatible — new affixes won't crash old engine).

/** How an affix is applied to the engine blueprint. */
type AffixKind =
  | 'mult_atk'        // Attack +X% (multiplicative, attack)
  | 'mult_siege'      // Siege value +X% (multiplicative, siegeValue — ADR-026: gear channel, mirrors mult_atk)
  | 'mult_hp'         // HP +X% (multiplicative, hp)
  | 'mult_atkspd'     // Attack speed +X% (reduces attackInterval)
  | 'mult_spd'        // Move speed +X% (multiplicative, speed)
  | 'flat_armor'      // Armor +N (additive, armor)
  | 'flat_lifesteal'  // Lifesteal +X% (additive to lifestealPct, 0–100 scale)
  | 'flat_regen'      // HP regen +N/s (additive, regenPerSec)
  | 'crit'            // Crit chance +X pts: additive into critPct across sources (trait T3 + equipment), Σ-then-clamp ≤50 (§7.7①); crit engine mechanic lives in CombatSystem
  | 'crit_mult'       // Crit damage +X pts: additive into critMult bonus (value/100), clamped by EFFECT_CAPS.critMult (§7.7①)
  | 'noncombat';      // Utility (material drop / stamina refund): not injected into combat blueprint, read by pveRewards (§7.5)

interface AffixDef {
  kind: AffixKind;
  /** true = primary affix, scales with enhancement level; false/omitted = secondary affix, fixed value. */
  main?: boolean;
}

/**
 * Affix id → application method. **Authoritative for mechanics** (§7.4/§7.5); concrete
 * value ranges/weights live in ECONOMY_NUMBERS §5, not here (this only determines
 * "which engine field this affix targets, and whether it multiplies or adds").
 */
export const AFFIX_FIELD_MAP: Readonly<Record<string, AffixDef>> = {
  // Primary affixes (§7.4, locked to slot, exactly 1 per item on roll; scales with enhancement)
  m_atk: { kind: 'mult_atk', main: true },
  m_siege: { kind: 'mult_siege', main: true },
  m_atkspd: { kind: 'mult_atkspd', main: true },
  m_hp: { kind: 'mult_hp', main: true },
  m_armor: { kind: 'flat_armor', main: true },
  m_spd: { kind: 'mult_spd', main: true },
  m_crit: { kind: 'crit', main: true },
  // Secondary affixes (§7.5 combat stats, rare/epic, fixed rolled value)
  s_atk: { kind: 'mult_atk' },
  s_siege: { kind: 'mult_siege' },
  s_hp: { kind: 'mult_hp' },
  s_armor: { kind: 'flat_armor' },
  s_spd: { kind: 'mult_spd' },
  s_atkspd: { kind: 'mult_atkspd' },
  s_lifesteal: { kind: 'flat_lifesteal' },
  s_regen: { kind: 'flat_regen' },
  s_critmult: { kind: 'crit_mult' },
  // Secondary affixes (§7.5 utility, excluded from combat power cap and blueprint)
  s_matdrop: { kind: 'noncombat' },
  s_stamina: { kind: 'noncombat' },
};

/** Enhancement coefficient: primary affix effective value = base × (1 + coefficient × level) (§7.3 DRAFT 0.10/level → +9 ≈ ×1.9). */
export const ENHANCE_COEFF_PER_LEVEL = 0.1;

// ── Cross-system caps (EQUIPMENT_DESIGN §7.7, prevents stat explosion, DRAFT [tunable]) ──
//
// Continuous effects are summed across all sources then clamped to global hard limits.
// Two clamping sites:
//   · Multiplicative percentages (atk/hp/atkspd): clamped at the **equipment contribution**
//     during the accumulation phase inside applyEquipment (once baked into absolute hp/attack
//     values they cannot be reversed — must clamp during accumulation).
//   · Absolute fields (lifestealPct): both equipment and traits write to the same field →
//     clamped once by clampEffectCaps at the end of injection (§7.7④), achieving a true
//     "trait + equipment sum then clamp" semantic.
//
// ⚠️ Current limitations (recorded as TODOs, not in this slice): trait attack speed/attack/HP
//    gains run through TraitSystem at runtime rather than the blueprint-baking phase → the
//    multiplicative "trait + equipment sum cap" is not yet fully unified. E1 guarantees
//    equipment-only caps + lifestealPct/critPct/critMult cross-source caps; full cross-source
//    unification of the multiplicative fields awaits trait numeric table alignment
//    (§7.7 limits belong to ECONOMY_NUMBERS §5).
export const EFFECT_CAPS = {
  /** Attack % equipment contribution cap (§7.7 ≤ +60%). */
  atkPct: 0.6,
  /** Siege value % equipment contribution cap (ADR-026, mirrors atkPct ≤ +60%). */
  siegePct: 0.6,
  /** HP % equipment contribution cap (§7.7 ≤ +60%). */
  hpPct: 0.6,
  /** Attack speed % equipment contribution cap (§7.7 ≤ +40%). */
  atkspdPct: 0.4,
  /** Lifesteal % all-source (trait T6 + secondary affix + skill proc) summed cap (§7.7 ≤ 30). */
  lifestealPct: 30,
  /** Armor flat equipment contribution cap (S12-E tightened: progression changed to armor:1/level, L9=+8; equipment cap 12 → combined total ≤20). */
  armorFlat: 12,
  /** Crit chance all-source (trait T3 + trinket main m_crit + sub-affix) summed cap (§7.7 ≤ 50, 0–100 scale). */
  critPct: 50,
  /** Crit damage multiplier all-source cap (T3 base 1.5× + s_critmult bonuses); prevents crit-damage explosion (§7.7 DRAFT). */
  critMult: 2.5,
} as const;

// ── Player unit types eligible for card-based equipment bonuses ───────────────────────────
//
// All six card-issuing unit types (three Tao + three Anna) can receive equipment bonuses via
// CardInstance.gear. PvE-exclusive enemy types (Ironclad/Runner/Harpy/support) have no cards.
// Exported so the client portrait overlay (EQUIPMENT_DESIGN §20.4) stays in sync with this set.
export const PLAYER_EQUIPPABLE_UNITS: readonly UnitType[] = [
  UnitType.Infantry,
  UnitType.ShieldBearer,
  UnitType.Archer,
  UnitType.Max,
  UnitType.Lena,
  UnitType.Mara,
];

// ── Engine-local input types (structurally equivalent to @nw/shared; no shared import) ─────
//
// Engine cannot import @nw/shared (mongodb would pollute the browser bundle via webpack alias).
// These types are structurally compatible with their @nw/shared counterparts; callers pass
// shared instances directly (TS structural subtyping — extra fields are harmless).

/** Affix instance (structurally equivalent to shared Affix). */
export interface EngineAffix {
  id: string;
  value: number;
}

/** Equipment instance (structural subset of shared EquipmentInstance; engine only needs level + affixes). */
export interface EngineEquipInstance {
  defId: string;
  level: number;
  affixes: EngineAffix[];
}

/** Slot → instance id (structurally equivalent to shared GearSlotMap; permissive index signature). */
export type EngineSlotMap = { readonly [slot: string]: string | undefined };

/**
 * Card instance as seen by the engine (structural subset of shared CardInstance).
 * The engine only needs id, unitType, level, and gear for blueprint injection.
 * Structurally compatible with shared CardInstance (extra fields like xp/locked are harmless).
 */
export interface EngineCardInstance {
  id: string;
  defId: string;
  /** Engine unit type (string value of UnitType enum, e.g. 'infantry', 'max'). */
  unitType: UnitType;
  level: number;
  gear: EngineSlotMap;
}

/** Equipment instance inventory: instanceId → EngineEquipInstance. Structurally compatible with SaveData.equipmentInv. */
export type EngineEquipInv = { readonly [instanceId: string]: EngineEquipInstance };

// ── Kept for backward-compat (still exported from index.ts; callers that reference EngineEquipmentInput as a type will not break) ──
/** @deprecated Use EngineCardInstance + EngineEquipInv instead (CC-1). Retained for external type references. */
export interface EngineGearLoadout {
  global?: EngineSlotMap;
  byUnit?: { readonly [unitType: string]: EngineSlotMap };
}
/** @deprecated Use EngineCardInstance + EngineEquipInv instead (CC-1). Retained for external type references. */
export interface EngineEquipmentInput {
  gear: EngineGearLoadout;
  inv: { readonly [instanceId: string]: EngineEquipInstance };
}

// ── Injection ─────────────────────────────────────────────────────────────────────

/** Per-unit-type effect accumulator (percentages as decimals: 0.12 = +12%; flat values are raw). */
interface EffectAccum {
  atkPct: number;
  siegePct: number;
  hpPct: number;
  atkspdPct: number;
  spdPct: number;
  armorFlat: number;
  lifestealFlat: number;
  regenFlat: number;
  /** Crit chance points (0–100 scale), additive across equipped items (§7.7①). */
  critPctFlat: number;
  /** Crit damage multiplier bonus (decimal, e.g. 0.20 = +20% crit damage), additive across items. */
  critMultBonus: number;
}

function zeroAccum(): EffectAccum {
  return { atkPct: 0, siegePct: 0, hpPct: 0, atkspdPct: 0, spdPct: 0, armorFlat: 0, lifestealFlat: 0, regenFlat: 0, critPctFlat: 0, critMultBonus: 0 };
}

/** Accumulates all affixes of one equipped item into acc (primary affixes scaled by enhancement level; utility/skill/unknown skipped). */
function accumInstance(acc: EffectAccum, inst: EngineEquipInstance): void {
  const level = Math.max(0, Math.min(inst.level ?? 0, 9));
  for (const affix of inst.affixes ?? []) {
    const def = AFFIX_FIELD_MAP[affix.id];
    if (!def) continue; // Unknown affix: silently ignored
    // Primary affixes scale with enhancement level; secondary affixes are fixed.
    const effective = def.main ? affix.value * (1 + ENHANCE_COEFF_PER_LEVEL * level) : affix.value;
    switch (def.kind) {
      case 'mult_atk':
        acc.atkPct += effective / 100;
        break;
      case 'mult_siege':
        acc.siegePct += effective / 100;
        break;
      case 'mult_hp':
        acc.hpPct += effective / 100;
        break;
      case 'mult_atkspd':
        acc.atkspdPct += effective / 100;
        break;
      case 'mult_spd':
        acc.spdPct += effective / 100;
        break;
      case 'flat_armor':
        acc.armorFlat += effective;
        break;
      case 'flat_lifesteal':
        acc.lifestealFlat += effective;
        break;
      case 'flat_regen':
        acc.regenFlat += effective;
        break;
      case 'crit': // Crit chance (m_crit, trinket main): additive points; scaled by enhancement (main affix).
        acc.critPctFlat += effective;
        break;
      case 'crit_mult': // Crit damage (s_critmult, sub-affix): fixed points → decimal bonus (value/100).
        acc.critMultBonus += effective / 100;
        break;
      case 'noncombat': // Utility (material drop / stamina refund): not injected into combat blueprint (§7.5)
        break;
    }
  }
}

function clamp(v: number, max: number): number {
  return v > max ? max : v < 0 ? 0 : v;
}

/**
 * Applies one card instance's equipped-item affix bonuses onto the card's unit-type blueprint in-place
 * (CHARACTER_CARDS_DESIGN §5.3 / EQUIPMENT_DESIGN §9).
 *
 * Equipment is now per-card (CardInstance.gear), not a global army loadout.
 * Each call injects one card's gear into bp[cardInstance.unitType] only.
 * Call once per card instance; call clampEffectCaps once after all cards are processed.
 *
 * @param bp           Blueprint table (intermediate state: after applyUnitLevels, before clampEffectCaps).
 * @param cardInstance The card whose gear is being injected. unitType determines the target blueprint slot.
 * @param inv          Full equipment instance inventory (SaveData.equipmentInv); used to resolve gear slot ids.
 */
export function applyEquipment(
  bp: Record<UnitType, UnitBlueprint>,
  cardInstance: EngineCardInstance,
  inv: EngineEquipInv,
): void {
  const slotMap = cardInstance.gear;
  const acc = zeroAccum();
  let worn = 0;
  for (const slot of Object.keys(slotMap)) {
    const instId = slotMap[slot];
    if (!instId) continue;
    const inst = inv[instId];
    if (!inst) continue; // Reference to non-existent instance: silently ignored
    accumInstance(acc, inst);
    worn++;
  }
  if (worn === 0) return;

  const u = bp[cardInstance.unitType];
  if (!u) return; // Unknown unit type (e.g. PvE-only enemy): silently ignored

  // Multiplicative fields: equipment contribution clamped here (§7.7 clamping site ①).
  u.attack = Math.round(u.attack * (1 + clamp(acc.atkPct, EFFECT_CAPS.atkPct)));
  // Siege value: own gear channel (ADR-026), same multiplicative arithmetic + cap as attack.
  u.siegeValue = Math.round(u.siegeValue * (1 + clamp(acc.siegePct, EFFECT_CAPS.siegePct)));
  u.hp = Math.round(u.hp * (1 + clamp(acc.hpPct, EFFECT_CAPS.hpPct)));
  // Attack speed: percentage reduces attackInterval (§7.4 "multiplicative (reduces interval)"); lower bound prevents 0/negative.
  const atkspd = clamp(acc.atkspdPct, EFFECT_CAPS.atkspdPct);
  if (atkspd > 0) u.attackInterval = u.attackInterval / (1 + atkspd);
  // Move speed: §7.7 table lists no cap → not clamped.
  if (acc.spdPct !== 0) u.speed = u.speed * (1 + acc.spdPct);
  // Absolute fields: accumulated, unified clamping deferred to clampEffectCaps (cross-source sum cap, §7.7④).
  if (acc.armorFlat !== 0) u.armor = (u.armor ?? 0) + acc.armorFlat;
  if (acc.lifestealFlat !== 0) u.lifestealPct = (u.lifestealPct ?? 0) + acc.lifestealFlat;
  if (acc.regenFlat !== 0) u.regenPerSec = (u.regenPerSec ?? 0) + acc.regenFlat;

  // Crit (§7.7①): chance is additive across all sources (trait T3 already baked by applyUnitLevels
  // + this equipment contribution), the ≤50 sum-cap is applied later in clampEffectCaps. An m_crit
  // trinket also establishes the T3 base multiplier (1.5×) so it crits meaningfully even on a unit
  // below the T3 breakpoint; s_critmult then adds on top. combatPrng only advances when critPct>0,
  // so PvP (no equipment, critPct stays 0) replays remain bit-identical (hardwall test).
  if (acc.critPctFlat > 0) {
    u.critPct = (u.critPct ?? 0) + acc.critPctFlat;
    u.critMult = Math.max(u.critMult ?? 1, TRAIT_BREAKPOINTS.crit.mult);
  }
  if (acc.critMultBonus > 0) u.critMult = (u.critMult ?? 1) + acc.critMultBonus;
}

/**
 * The **single unified clamping site** for cross-system caps (EQUIPMENT_DESIGN §7.7④):
 * executed once after both applyPveUpgrades and applyEquipment have been stacked, clamping
 * the all-source sum of **absolute fields** (traits and equipment write to the same field,
 * e.g. lifestealPct). Multiplicative percentage caps are already applied during the
 * accumulation phase in applyEquipment (irreversible after baking); this function covers
 * the remaining absolute fields.
 */
export function clampEffectCaps(bp: Record<UnitType, UnitBlueprint>): void {
  for (const unitType of Object.keys(bp) as UnitType[]) {
    const u = bp[unitType];
    if (u.lifestealPct !== undefined) {
      u.lifestealPct = clamp(u.lifestealPct, EFFECT_CAPS.lifestealPct);
    }
    if (u.armor !== undefined) {
      // Armor flat all-source cap (base armor + equipment); prevents late-game damage-reduction overflow (§7.7).
      u.armor = Math.min(u.armor, EFFECT_CAPS.armorFlat);
    }
    if (u.critPct !== undefined) {
      // Crit chance all-source sum cap (trait T3 + equipment), §7.7① ≤50 (0–100 scale).
      u.critPct = Math.min(u.critPct, EFFECT_CAPS.critPct);
    }
    if (u.critMult !== undefined) {
      // Crit damage multiplier all-source cap (§7.7 DRAFT); prevents crit-damage explosion.
      u.critMult = Math.min(u.critMult, EFFECT_CAPS.critMult);
    }
  }
}
