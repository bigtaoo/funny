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
  | 'mult_hp'         // HP +X% (multiplicative, hp)
  | 'mult_atkspd'     // Attack speed +X% (reduces attackInterval)
  | 'mult_spd'        // Move speed +X% (multiplicative, speed)
  | 'flat_armor'      // Armor +N (additive, armor)
  | 'flat_lifesteal'  // Lifesteal +X% (additive to lifestealPct, 0–100 scale)
  | 'flat_regen'      // HP regen +N/s (additive, regenPerSec)
  | 'crit'            // Crit +X%: engine crit mechanic (same as trait T3) not yet implemented → placeholder no-op (§7.4 note)
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
  m_atkspd: { kind: 'mult_atkspd', main: true },
  m_hp: { kind: 'mult_hp', main: true },
  m_armor: { kind: 'flat_armor', main: true },
  m_spd: { kind: 'mult_spd', main: true },
  m_crit: { kind: 'crit', main: true },
  // Secondary affixes (§7.5 combat stats, rare/epic, fixed rolled value)
  s_atk: { kind: 'mult_atk' },
  s_hp: { kind: 'mult_hp' },
  s_armor: { kind: 'flat_armor' },
  s_spd: { kind: 'mult_spd' },
  s_atkspd: { kind: 'mult_atkspd' },
  s_lifesteal: { kind: 'flat_lifesteal' },
  s_regen: { kind: 'flat_regen' },
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
// ⚠️ Current limitations (recorded as TODOs, not in this slice): crit depends on the
//    unimplemented engine crit mechanic (§7.4 note); trait attack speed/attack/HP gains
//    run through TraitSystem at runtime rather than the blueprint-baking phase → the
//    multiplicative "trait + equipment sum cap" is not yet fully unified. E1 guarantees
//    equipment-only caps + lifestealPct cross-source caps; full cross-source unification
//    awaits the crit/proc framework and trait numeric table alignment
//    (§7.7 limits belong to ECONOMY_NUMBERS §5).
export const EFFECT_CAPS = {
  /** Attack % equipment contribution cap (§7.7 ≤ +60%). */
  atkPct: 0.6,
  /** HP % equipment contribution cap (§7.7 ≤ +60%). */
  hpPct: 0.6,
  /** Attack speed % equipment contribution cap (§7.7 ≤ +40%). */
  atkspdPct: 0.4,
  /** Lifesteal % all-source (trait T6 + secondary affix + skill proc) summed cap (§7.7 ≤ 30). */
  lifestealPct: 30,
  /** Armor flat equipment contribution cap (S12-E tightened: progression changed to armor:1/level, L9=+8; equipment cap 12 → combined total ≤20). */
  armorFlat: 12,
} as const;

// ── Player unit types eligible for global loadout bonuses (§8 "affects the whole army") ──
//
// Consistent with pveUpgrades: only the card-issuing unit types in the player lineup
// (Infantry/ShieldBearer/Archer) receive bonuses; PvE-exclusive enemy types
// (Ironclad/Runner/Harpy/support) have no cards and are not in the player lineup → no bonus.
// Note: like applyPveUpgrades, this operates on the **shared blueprint table** (keyed by
// UnitType); siege attacker/defender sharing the same table is existing behaviour and is
// preserved as-is (this is the established semantics of §9 "single injection site";
// attacker/defender separation is not expanded in E1).
export const PLAYER_EQUIPPABLE_UNITS: readonly UnitType[] = [
  UnitType.Infantry,
  UnitType.ShieldBearer,
  UnitType.Archer,
];

// ── Engine-local input types (structurally equivalent to @nw/shared; no shared import) ─────

/** Affix instance (structurally equivalent to shared Affix). */
export interface EngineAffix {
  id: string;
  value: number;
}

/** Equipment instance (structural subset of shared EquipmentInstance; engine only needs these three fields). */
export interface EngineEquipInstance {
  defId: string;
  level: number;
  affixes: EngineAffix[];
}

/** Slot → instance id (structurally equivalent to shared GearSlotMap; uses a permissive index signature to accommodate Partial<Record<EquipSlot,…>>). */
export type EngineSlotMap = { readonly [slot: string]: string | undefined };

/** Equipped loadout (structurally equivalent to shared GearLoadout). */
export interface EngineGearLoadout {
  global?: EngineSlotMap;
  byUnit?: { readonly [unitType: string]: EngineSlotMap };
}

/** Input to applyEquipment: equipped loadout + instance inventory (dereferenced by id). */
export interface EngineEquipmentInput {
  gear: EngineGearLoadout;
  inv: { readonly [instanceId: string]: EngineEquipInstance };
}

// ── Injection ─────────────────────────────────────────────────────────────────────

/** Per-unit-type effect accumulator (percentages as decimals: 0.12 = +12%; flat values are raw). */
interface EffectAccum {
  atkPct: number;
  hpPct: number;
  atkspdPct: number;
  spdPct: number;
  armorFlat: number;
  lifestealFlat: number;
  regenFlat: number;
}

function zeroAccum(): EffectAccum {
  return { atkPct: 0, hpPct: 0, atkspdPct: 0, spdPct: 0, armorFlat: 0, lifestealFlat: 0, regenFlat: 0 };
}

/** Returns the active slot→instance-id map for a unit type: byUnit takes priority (phase 2), falling back to global (phase 1 whole-army). */
function loadoutFor(gear: EngineGearLoadout, unitType: UnitType): EngineSlotMap | undefined {
  return gear.byUnit?.[unitType] ?? gear.global;
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
      case 'crit': // Crit mechanic not yet implemented (§7.4 note): placeholder no-op
      case 'noncombat': // Utility (material drop / stamina refund): not injected into combat blueprint (§7.5)
        break;
    }
  }
}

function clamp(v: number, max: number): number {
  return v > max ? max : v < 0 ? 0 : v;
}

/**
 * Applies equipped-item affix bonuses onto blueprints in-place (EQUIPMENT_DESIGN §9).
 * The **equipment contribution** to multiplicative fields is clamped here against EFFECT_CAPS
 * (once baked into absolute hp/attack values they cannot be reversed); absolute fields
 * (lifestealPct/armor) are accumulated and left for clampEffectCaps to clamp uniformly.
 *
 * @param bp    Blueprint table (intermediate state: after applyPveUpgrades, before clampEffectCaps).
 * @param equip Equipped loadout + instance inventory. No-op when absent/empty (no equipment = blueprint unchanged).
 */
export function applyEquipment(
  bp: Record<UnitType, UnitBlueprint>,
  equip: EngineEquipmentInput | undefined,
): void {
  if (!equip) return;
  const { gear, inv } = equip;
  if (!gear || !inv) return;

  for (const unitType of PLAYER_EQUIPPABLE_UNITS) {
    const slotMap = loadoutFor(gear, unitType);
    if (!slotMap) continue;
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
    if (worn === 0) continue;

    const u = bp[unitType];
    // Multiplicative fields: equipment contribution clamped here (§7.7 clamping site ①).
    u.attack = Math.round(u.attack * (1 + clamp(acc.atkPct, EFFECT_CAPS.atkPct)));
    u.hp = Math.round(u.hp * (1 + clamp(acc.hpPct, EFFECT_CAPS.hpPct)));
    // Attack speed: percentage reduces attackInterval (§7.4 "multiplicative (reduces interval)"); lower bound prevents 0/negative.
    const atkspd = clamp(acc.atkspdPct, EFFECT_CAPS.atkspdPct);
    if (atkspd > 0) u.attackInterval = u.attackInterval / (1 + atkspd);
    // Move speed: §7.7 table lists no cap → not clamped (speed carries no damage-immunity/overflow risk).
    if (acc.spdPct !== 0) u.speed = u.speed * (1 + acc.spdPct);
    // Absolute fields: accumulated, unified clamping deferred to clampEffectCaps (cross-source sum cap, §7.7④).
    if (acc.armorFlat !== 0) u.armor = (u.armor ?? 0) + acc.armorFlat;
    if (acc.lifestealFlat !== 0) u.lifestealPct = (u.lifestealPct ?? 0) + acc.lifestealFlat;
    if (acc.regenFlat !== 0) u.regenPerSec = (u.regenPerSec ?? 0) + acc.regenFlat;
  }
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
  }
}
