/**
 * Equipment crit injection tests (EQUIPMENT_DESIGN §7.4/§7.7, design B: m_crit chance + s_critmult multiplier).
 *
 * Verifies the blueprint-baking side (balance/equipment.ts applyEquipment + clampEffectCaps):
 *  1. m_crit trinket adds crit chance and establishes the T3 base multiplier (1.5×) on an L1 unit (no T3).
 *  2. s_critmult adds to the crit multiplier on top of the base.
 *  3. All-source sum caps: critPct ≤ 50 (§7.7① 0–100 scale), critMult ≤ EFFECT_CAPS.critMult.
 *  4. crit chance is additive with trait T3 (equipment stacks on top, not max).
 *  5. No gear ⟹ no equipment crit (L1 unit stays at critPct 0) — equipment is the only injection source.
 *  6. ENHANCE_LEVEL_MULTIPLIER / enhanceMultiplier(): table shape (monotonic, +0 = 1.00), level
 *     clamping at both ends, and an m_crit-level integration check computed FROM the table (not a
 *     hand-copied literal) so a future tuning pass can't silently drift out of sync with this file
 *     the way it did for the +9 case (ADR-063 follow-up, see the test below with a literal anchor).
 *
 * ADR-065: critPct/critMult are fp (scale = FP_SCALE = 1000) — every expected value below is built
 * with toFp()/mulFp()/addFp() rather than a bare scaled integer, so intent stays legible and the fp
 * arithmetic exactly mirrors what balance/equipment.ts does (no epsilon comparisons needed — fp
 * truncation is deterministic, not floating-point-imprecise).
 *
 * The PvP hard wall (critPct stays 0 in PvP because applyEquipment is never called there) is covered
 * by pvp_hardwall.test.ts; combat-time crit rolling is covered by CombatSystem (deterministic combatPrng).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildCampaignBlueprints } from '../balance/pveUpgrades';
import {
  EFFECT_CAPS,
  ENHANCE_LEVEL_MULTIPLIER,
  enhanceMultiplier,
  type EngineCardInstance,
  type EngineEquipInv,
} from '../balance/equipment';
import { TRAIT_BREAKPOINTS } from '../balance/progression';
import { toFp, mulFp, addFp } from '../math/fixed';
import { UnitType } from '../types';

const BASE_MULT = TRAIT_BREAKPOINTS.crit.mult; // 1.5× (fp)

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
  assert.equal(u.critPct_fp, toFp(6), 'L1 base crit is 0, +6 from m_crit');
  assert.equal(u.critMult_fp, BASE_MULT, 'm_crit establishes the T3 base multiplier so it crits meaningfully');
});

test('m_crit scales with enhancement level (main affix): +9 = ×5.00', () => {
  const inv: EngineEquipInv = { eq1: { defId: 'tk_seal', level: 9, affixes: [{ id: 'm_crit', value: 6 }] } };
  const bp = buildCampaignBlueprints([card(1, 'eq1')], inv);
  // effective = base × ENHANCE_LEVEL_MULTIPLIER[9] = 6 × 5.00 = 30 (ADR-063 follow-up, commit
  // 398a58cb bumped the +9 table entry from 4.06× to 5.00×; this test's expected value tracks
  // that table, not a flat 0.10/level formula — see balance/equipment.ts ENHANCE_LEVEL_MULTIPLIER).
  const critPct_fp = bp[UnitType.Infantry].critPct_fp ?? toFp(0);
  assert.equal(critPct_fp, toFp(30), `expected ${toFp(30)}, got ${critPct_fp}`);
});

// ── 2. s_critmult adds to the multiplier ───────────────────────────────────────────────────

test('s_critmult: adds value/100 to the crit multiplier on top of the base', () => {
  const inv: EngineEquipInv = {
    eq1: { defId: 'tk_seal', level: 0, affixes: [{ id: 'm_crit', value: 6 }, { id: 's_critmult', value: 20 }] },
  };
  const bp = buildCampaignBlueprints([card(1, 'eq1')], inv);
  assert.equal(bp[UnitType.Infantry].critPct_fp, toFp(6));
  assert.equal(bp[UnitType.Infantry].critMult_fp, toFp(1.7), 'base 1.5 + 0.20 = 1.7');
});

// ── 3. All-source sum caps ──────────────────────────────────────────────────────────────────

test('crit chance is clamped to EFFECT_CAPS.critPct_fp across all sources', () => {
  const inv: EngineEquipInv = { eq1: { defId: 'tk_seal', level: 0, affixes: [{ id: 'm_crit', value: 999 }] } };
  const bp = buildCampaignBlueprints([card(1, 'eq1')], inv);
  assert.equal(bp[UnitType.Infantry].critPct_fp, EFFECT_CAPS.critPct_fp, 'oversized crit chance clamps to the ≤50 cap');
});

test('crit multiplier is clamped to EFFECT_CAPS.critMult_fp', () => {
  const inv: EngineEquipInv = {
    eq1: { defId: 'tk_seal', level: 0, affixes: [{ id: 'm_crit', value: 6 }, { id: 's_critmult', value: 999 }] },
  };
  const bp = buildCampaignBlueprints([card(1, 'eq1')], inv);
  assert.equal(bp[UnitType.Infantry].critMult_fp, EFFECT_CAPS.critMult_fp, 'oversized crit damage clamps to the cap');
});

// ── 4. Additive with trait T3 (not max) ─────────────────────────────────────────────────────

test('equipment crit chance stacks additively on top of trait T3', () => {
  // L3 unit: T3 grants critPct = TRAIT_BREAKPOINTS.crit.pct. Equipment m_crit adds on top.
  const inv: EngineEquipInv = { eq1: { defId: 'tk_seal', level: 0, affixes: [{ id: 'm_crit', value: 6 }] } };
  const bp = buildCampaignBlueprints([card(3, 'eq1')], inv);
  assert.equal(bp[UnitType.Infantry].critPct_fp, addFp(TRAIT_BREAKPOINTS.crit.pct, toFp(6)), 'T3 base + equipment, summed');
});

// ── 5. No gear ⟹ equipment is the only crit source ─────────────────────────────────────────

test('no gear: L1 unit has no crit (equipment is the only injection source)', () => {
  const bp = buildCampaignBlueprints([card(1)], {});
  assert.equal(bp[UnitType.Infantry].critPct_fp ?? toFp(0), toFp(0), 'L1 + no gear ⟹ critPct 0');
});

// ── 6. ENHANCE_LEVEL_MULTIPLIER table shape + enhanceMultiplier() level clamping ────────────

test('ENHANCE_LEVEL_MULTIPLIER: +0 is 1.00 (no enhancement ⟹ no bonus)', () => {
  assert.equal(enhanceMultiplier(0), toFp(1.0));
});

test('ENHANCE_LEVEL_MULTIPLIER: +6 breakpoint is 1.76× (literal anchor, ADR-063)', () => {
  // Literal anchor on the documented "awakening" breakpoint value in balance/equipment.ts.
  // Unlike the generic monotonicity/clamping checks below, this one intentionally hardcodes
  // the table's current value so that a future tuning pass must consciously touch this test
  // (the same class of drift that went unnoticed for +9 until this file was fixed).
  assert.equal(enhanceMultiplier(6), toFp(1.76));
});

test('ENHANCE_LEVEL_MULTIPLIER: +9 is 5.00× (literal anchor, ADR-063 2026-08-10 bump)', () => {
  assert.equal(enhanceMultiplier(9), toFp(5.0));
  assert.equal(ENHANCE_LEVEL_MULTIPLIER[ENHANCE_LEVEL_MULTIPLIER.length - 1], toFp(5.0));
});

test('ENHANCE_LEVEL_MULTIPLIER: strictly monotonically increasing across the whole table', () => {
  // Design intent (§7.3): more enhancement never pays off less. This holds regardless of how
  // the concrete per-level numbers get retuned, so it survives future balance passes untouched.
  for (let i = 1; i < ENHANCE_LEVEL_MULTIPLIER.length; i++) {
    assert.ok(
      ENHANCE_LEVEL_MULTIPLIER[i]! > ENHANCE_LEVEL_MULTIPLIER[i - 1]!,
      `level ${i} (${ENHANCE_LEVEL_MULTIPLIER[i]}) must exceed level ${i - 1} (${ENHANCE_LEVEL_MULTIPLIER[i - 1]})`,
    );
  }
});

test('enhanceMultiplier: clamps below +0 and above the table\'s max index', () => {
  const maxLevel = ENHANCE_LEVEL_MULTIPLIER.length - 1;
  assert.equal(enhanceMultiplier(-5), enhanceMultiplier(0), 'negative level clamps to +0');
  assert.equal(enhanceMultiplier(maxLevel + 20), enhanceMultiplier(maxLevel), 'over-range level clamps to the table max (+9)');
});

test('enhanceMultiplier: rounds a fractional level to the nearest table entry', () => {
  assert.equal(enhanceMultiplier(4.6), enhanceMultiplier(5), '4.6 rounds up to +5');
  assert.equal(enhanceMultiplier(4.4), enhanceMultiplier(4), '4.4 rounds down to +4');
});

test('m_crit at the +6 breakpoint: effective value computed from the table, not a hand-copied literal', () => {
  // Cross-checks the integration path (accumInstance → applyEquipment) against enhanceMultiplier()
  // itself, so this assertion can never drift out of sync with the table the way the old +9 test did.
  const inv: EngineEquipInv = { eq1: { defId: 'tk_seal', level: 6, affixes: [{ id: 'm_crit', value: 6 }] } };
  const bp = buildCampaignBlueprints([card(1, 'eq1')], inv);
  const expected = mulFp(toFp(6), enhanceMultiplier(6));
  assert.equal(bp[UnitType.Infantry].critPct_fp ?? toFp(0), expected, `expected ${expected}`);
});

test('instance level above +9 is clamped before scaling (accumInstance clamps inst.level to [0,9])', () => {
  // An out-of-range stored level (shouldn't happen via normal enhancement flow, but defends
  // against bad save data) must not scale past the +9 table entry.
  const inv: EngineEquipInv = { eq1: { defId: 'tk_seal', level: 999, affixes: [{ id: 'm_crit', value: 6 }] } };
  const bp = buildCampaignBlueprints([card(1, 'eq1')], inv);
  const expected = mulFp(toFp(6), enhanceMultiplier(9));
  assert.equal(bp[UnitType.Infantry].critPct_fp ?? toFp(0), expected, `expected ${expected}, clamped to +9 scaling`);
});
