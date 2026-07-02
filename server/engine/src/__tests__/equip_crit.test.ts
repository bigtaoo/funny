/**
 * Equipment crit injection tests (EQUIPMENT_DESIGN §7.4/§7.7, design B: m_crit chance + s_critmult multiplier).
 *
 * Verifies the blueprint-baking side (balance/equipment.ts applyEquipment + clampEffectCaps):
 *  1. m_crit trinket adds crit chance and establishes the T3 base multiplier (1.5×) on an L1 unit (no T3).
 *  2. s_critmult adds to the crit multiplier on top of the base.
 *  3. All-source sum caps: critPct ≤ 50 (§7.7① 0–100 scale), critMult ≤ EFFECT_CAPS.critMult.
 *  4. crit chance is additive with trait T3 (equipment stacks on top, not max).
 *  5. No gear ⟹ no equipment crit (L1 unit stays at critPct 0) — equipment is the only injection source.
 *
 * The PvP hard wall (critPct stays 0 in PvP because applyEquipment is never called there) is covered
 * by pvp_hardwall.test.ts; combat-time crit rolling is covered by CombatSystem (deterministic combatPrng).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildCampaignBlueprints } from '../balance/pveUpgrades';
import { EFFECT_CAPS, type EngineCardInstance, type EngineEquipInv } from '../balance/equipment';
import { TRAIT_BREAKPOINTS } from '../balance/progression';
import { UnitType } from '../types';

const BASE_MULT = TRAIT_BREAKPOINTS.crit.mult; // 1.5×

/** One Infantry card at the given level wearing the given trinket instance id. */
function card(level: number, trinketId?: string): EngineCardInstance {
  return {
    id: 'c_inf',
    defId: UnitType.Infantry,
    unitType: UnitType.Infantry,
    level,
    gear: trinketId ? { trinket: trinketId } : {},
  };
}

// ── 1. m_crit adds chance + establishes base multiplier on an L1 unit (no T3) ──────────────

test('m_crit trinket: L1 unit gains crit chance + base 1.5× multiplier', () => {
  const inv: EngineEquipInv = { eq1: { defId: 'tk_seal', level: 0, affixes: [{ id: 'm_crit', value: 6 }] } };
  const bp = buildCampaignBlueprints([card(1, 'eq1')], inv);
  const u = bp[UnitType.Infantry];
  assert.equal(u.critPct, 6, 'L1 base crit is 0, +6 from m_crit');
  assert.equal(u.critMult, BASE_MULT, 'm_crit establishes the T3 base multiplier so it crits meaningfully');
});

test('m_crit scales with enhancement level (main affix): +9 ≈ ×1.9', () => {
  const inv: EngineEquipInv = { eq1: { defId: 'tk_seal', level: 9, affixes: [{ id: 'm_crit', value: 6 }] } };
  const bp = buildCampaignBlueprints([card(1, 'eq1')], inv);
  // effective = 6 × (1 + 0.1 × 9) = 11.4 → rounded via additive accumulation (6*1.9 = 11.4)
  const critPct = bp[UnitType.Infantry].critPct ?? 0;
  assert.ok(Math.abs(critPct - 11.4) < 1e-9, `expected ~11.4, got ${critPct}`);
});

// ── 2. s_critmult adds to the multiplier ───────────────────────────────────────────────────

test('s_critmult: adds value/100 to the crit multiplier on top of the base', () => {
  const inv: EngineEquipInv = {
    eq1: { defId: 'tk_seal', level: 0, affixes: [{ id: 'm_crit', value: 6 }, { id: 's_critmult', value: 20 }] },
  };
  const bp = buildCampaignBlueprints([card(1, 'eq1')], inv);
  assert.equal(bp[UnitType.Infantry].critPct, 6);
  assert.ok(Math.abs(bp[UnitType.Infantry].critMult! - (BASE_MULT + 0.2)) < 1e-9, 'base 1.5 + 0.20 = 1.7');
});

// ── 3. All-source sum caps ──────────────────────────────────────────────────────────────────

test('crit chance is clamped to EFFECT_CAPS.critPct across all sources', () => {
  const inv: EngineEquipInv = { eq1: { defId: 'tk_seal', level: 0, affixes: [{ id: 'm_crit', value: 999 }] } };
  const bp = buildCampaignBlueprints([card(1, 'eq1')], inv);
  assert.equal(bp[UnitType.Infantry].critPct, EFFECT_CAPS.critPct, 'oversized crit chance clamps to the ≤50 cap');
});

test('crit multiplier is clamped to EFFECT_CAPS.critMult', () => {
  const inv: EngineEquipInv = {
    eq1: { defId: 'tk_seal', level: 0, affixes: [{ id: 'm_crit', value: 6 }, { id: 's_critmult', value: 999 }] },
  };
  const bp = buildCampaignBlueprints([card(1, 'eq1')], inv);
  assert.equal(bp[UnitType.Infantry].critMult, EFFECT_CAPS.critMult, 'oversized crit damage clamps to the cap');
});

// ── 4. Additive with trait T3 (not max) ─────────────────────────────────────────────────────

test('equipment crit chance stacks additively on top of trait T3', () => {
  // L3 unit: T3 grants critPct = TRAIT_BREAKPOINTS.crit.pct. Equipment m_crit adds on top.
  const inv: EngineEquipInv = { eq1: { defId: 'tk_seal', level: 0, affixes: [{ id: 'm_crit', value: 6 }] } };
  const bp = buildCampaignBlueprints([card(3, 'eq1')], inv);
  assert.equal(bp[UnitType.Infantry].critPct, TRAIT_BREAKPOINTS.crit.pct + 6, 'T3 base + equipment, summed');
});

// ── 5. No gear ⟹ equipment is the only crit source ─────────────────────────────────────────

test('no gear: L1 unit has no crit (equipment is the only injection source)', () => {
  const bp = buildCampaignBlueprints([card(1)], {});
  assert.equal(bp[UnitType.Infantry].critPct ?? 0, 0, 'L1 + no gear ⟹ critPct 0');
});
