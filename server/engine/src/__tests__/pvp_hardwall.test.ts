/**
 * CC-1 PvP hard-wall tests (updated from S12 A2).
 *
 * Core invariant: buildPvpBlueprints() must return a clone that is word-for-word equal to UNIT_BLUEPRINTS,
 * meaning no trait / armor / card progression / equipment stat from any campaign/siege path can leak into PvP blueprints.
 * This is the runtime guard for "PvP fairness hard line §5.2": a failing test means something has leaked into PvP.
 *
 * CC-1 change: buildCampaignBlueprints now takes EngineCardInstance[] instead of (levels, equip, unitLevels).
 * The hard-wall invariant is unchanged; the test helpers are updated to construct card instances.
 *
 * ADR-065: hp/attack/armor/critPct/lifestealPct/armorEnrageThreshold/armorEnrageBonus/reflectPct are fp
 * (scale = FP_SCALE = 1000) — literals below go through toFp() rather than a bare scaled integer.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { UNIT_BLUEPRINTS } from '../config';
import { buildPvpBlueprints, buildCampaignBlueprints } from '../balance/pveUpgrades';
import { UNIT_MAX_LEVEL } from '../balance/progression';
import { toFp } from '../math/fixed';
import { UnitType } from '../types';
import type { EngineCardInstance } from '../balance/equipment';

const PVP_UNITS = [UnitType.Infantry, UnitType.ShieldBearer, UnitType.Archer] as const;

/** Builds card instances for the given unit types at the specified level. */
function makeCards(units: readonly UnitType[], level: number): EngineCardInstance[] {
  return units.map((ut) => ({ id: `test_${ut}`, defId: ut, unitType: ut, level, gear: {} }));
}

// ── buildPvpBlueprints is word-for-word equal to the UNIT_BLUEPRINTS constants ─────────────────────────

test('buildPvpBlueprints: all PvP unit blueprints exactly equal UNIT_BLUEPRINTS constants', () => {
  const pvp = buildPvpBlueprints();
  for (const ut of PVP_UNITS) {
    const ref = UNIT_BLUEPRINTS[ut];
    const got = pvp[ut];
    assert.equal(got.hp_fp,           ref.hp_fp,          `${ut}.hp`);
    assert.equal(got.attack_fp,       ref.attack_fp,       `${ut}.attack`);
    assert.equal(got.attackInterval, ref.attackInterval, `${ut}.attackInterval`);
    assert.equal(got.speed,          ref.speed,          `${ut}.speed`);
    assert.equal(got.range,          ref.range,          `${ut}.range`);
    assert.equal(got.spawnCount,     ref.spawnCount,     `${ut}.spawnCount`);
    // Trait fields that MUST stay at baseline (0 / undefined) in PvP.
    assert.equal(got.armor_fp        ?? toFp(0), toFp(0), `${ut} PvP armor must be 0`);
    assert.equal(got.critPct_fp      ?? toFp(0), toFp(0), `${ut} PvP critPct must be 0`);
    assert.equal(got.lifestealPct_fp ?? toFp(0), toFp(0), `${ut} PvP lifestealPct must be 0`);
    // Per-unit T9 progression traits (2026-08-05, ECONOMY_NUMBERS §4.4) — same hard wall applies.
    assert.equal(got.armorEnrageThreshold_fp ?? toFp(0), toFp(0), `${ut} PvP armorEnrageThreshold must be 0`);
    assert.equal(got.armorEnrageBonus_fp     ?? toFp(0), toFp(0), `${ut} PvP armorEnrageBonus must be 0`);
    assert.equal(got.reflectPct_fp           ?? toFp(0), toFp(0), `${ut} PvP reflectPct must be 0`);
  }
});

// ── PvP blueprints are independent clones (mutating them does not affect the global constant) ───────

test('buildPvpBlueprints: returned object is a clone, not the global constant', () => {
  const pvp = buildPvpBlueprints();
  pvp[UnitType.Infantry].hp_fp = toFp(9999);
  assert.equal(UNIT_BLUEPRINTS[UnitType.Infantry].hp_fp, toFp(60), 'UNIT_BLUEPRINTS constant must not be mutated');
});

// ── Max-level campaign blueprints do not pollute subsequent buildPvpBlueprints calls ─────────────────────

test('buildCampaignBlueprints at max level does not pollute subsequent buildPvpBlueprints', () => {
  buildCampaignBlueprints(makeCards(PVP_UNITS, UNIT_MAX_LEVEL)); // mutates internal clone; discard result

  const pvp = buildPvpBlueprints();
  for (const ut of PVP_UNITS) {
    assert.equal(pvp[ut].hp_fp,          UNIT_BLUEPRINTS[ut].hp_fp, `${ut}.hp after campaign call`);
    assert.equal(pvp[ut].armor_fp  ?? toFp(0), toFp(0),             `${ut} armor after campaign call`);
    assert.equal(pvp[ut].critPct_fp ?? toFp(0), toFp(0),            `${ut} critPct after campaign call`);
  }
});

// ── PvP path does not inject unit levels (spawnCount unchanged) ───────────────────────────────────

test('buildPvpBlueprints: spawnCount equals UNIT_BLUEPRINTS (no T9 +1 spawn leak)', () => {
  const pvp = buildPvpBlueprints();
  for (const ut of PVP_UNITS) {
    assert.equal(pvp[ut].spawnCount, UNIT_BLUEPRINTS[ut].spawnCount, `${ut} spawnCount must match base blueprint in PvP`);
  }
});

// ── CC-1: buildPvpBlueprints signature accepts no card/equipment parameters (compile-time hard wall) ──
// This test is a compile-time guard: if buildPvpBlueprints() acquired a parameter, tsc would fail here.
// The runtime assertion trivially passes; the value is in confirming the function signature is unchanged.
test('buildPvpBlueprints: zero-parameter signature (compile-time card contamination guard)', () => {
  const pvp = buildPvpBlueprints(); // must compile without any argument
  assert.ok(pvp !== null, 'buildPvpBlueprints returns a non-null blueprint table');
});

// ── Max-level campaign blueprints confirm trait thresholds are active (contrast: PvE progression works) ──

test('buildCampaignBlueprints at level 9: traits are applied (contrast: PvE path works)', () => {
  const campaign = buildCampaignBlueprints(makeCards(PVP_UNITS, UNIT_MAX_LEVEL));
  for (const ut of PVP_UNITS) {
    // T3/T6 stay universal across all progressable units regardless of T9 differentiation.
    assert.ok((campaign[ut].critPct_fp      ?? toFp(0)) > 0, `${ut} should have critPct>0 in PvE at L9`);
    assert.ok((campaign[ut].lifestealPct_fp ?? toFp(0)) > 0, `${ut} should have lifestealPct>0 in PvE at L9`);
    assert.equal(campaign[ut].armor_fp ?? toFp(0), toFp(8), `${ut} should have armor=8 at L9`);
  }
  // T9 is per-unit (2026-08-05, ECONOMY_NUMBERS §4.4): Infantry has no PER_UNIT_T9_TRAITS entry
  // and keeps the generic +1 spawn fallback; ShieldBearer/Archer each get their own T9 payoff instead.
  assert.equal(campaign[UnitType.Infantry].spawnCount, UNIT_BLUEPRINTS[UnitType.Infantry].spawnCount + 1,
    'Infantry (undifferentiated) should keep the generic +1 spawnCount at L9');
  assert.equal(campaign[UnitType.ShieldBearer].spawnCount, UNIT_BLUEPRINTS[UnitType.ShieldBearer].spawnCount,
    'ShieldBearer should NOT get +1 spawnCount at L9 (replaced by armor-enrage)');
  assert.equal(campaign[UnitType.ShieldBearer].armorEnrageThreshold_fp, toFp(0.4), 'ShieldBearer should have armorEnrageThreshold=0.4 at L9');
  assert.equal(campaign[UnitType.ShieldBearer].armorEnrageBonus_fp, toFp(6), 'ShieldBearer should have armorEnrageBonus=6 at L9');
  assert.equal(campaign[UnitType.Archer].spawnCount, UNIT_BLUEPRINTS[UnitType.Archer].spawnCount,
    'Archer should NOT get +1 spawnCount at L9 (replaced by range bonus)');
  assert.equal(campaign[UnitType.Archer].range, UNIT_BLUEPRINTS[UnitType.Archer].range + 1, 'Archer should have range+1 at L9');
});
