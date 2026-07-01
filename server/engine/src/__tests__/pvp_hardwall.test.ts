/**
 * CC-1 PvP hard-wall tests (updated from S12 A2).
 *
 * Core invariant: buildPvpBlueprints() must return a clone that is word-for-word equal to UNIT_BLUEPRINTS,
 * meaning no trait / armor / card progression / equipment stat from any campaign/siege path can leak into PvP blueprints.
 * This is the runtime guard for "PvP fairness hard line §5.2": a failing test means something has leaked into PvP.
 *
 * CC-1 change: buildCampaignBlueprints now takes EngineCardInstance[] instead of (levels, equip, unitLevels).
 * The hard-wall invariant is unchanged; the test helpers are updated to construct card instances.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { UNIT_BLUEPRINTS } from '../config';
import { buildPvpBlueprints, buildCampaignBlueprints } from '../balance/pveUpgrades';
import { UNIT_MAX_LEVEL } from '../balance/progression';
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
    assert.equal(got.hp,             ref.hp,             `${ut}.hp`);
    assert.equal(got.attack,         ref.attack,         `${ut}.attack`);
    assert.equal(got.attackInterval, ref.attackInterval, `${ut}.attackInterval`);
    assert.equal(got.speed,          ref.speed,          `${ut}.speed`);
    assert.equal(got.range,          ref.range,          `${ut}.range`);
    assert.equal(got.spawnCount,     ref.spawnCount,     `${ut}.spawnCount`);
    // Trait fields that MUST stay at baseline (0 / undefined) in PvP.
    assert.equal(got.armor        ?? 0, 0, `${ut} PvP armor must be 0`);
    assert.equal(got.critPct      ?? 0, 0, `${ut} PvP critPct must be 0`);
    assert.equal(got.lifestealPct ?? 0, 0, `${ut} PvP lifestealPct must be 0`);
  }
});

// ── PvP blueprints are independent clones (mutating them does not affect the global constant) ───────

test('buildPvpBlueprints: returned object is a clone, not the global constant', () => {
  const pvp = buildPvpBlueprints();
  pvp[UnitType.Infantry].hp = 9999;
  assert.equal(UNIT_BLUEPRINTS[UnitType.Infantry].hp, 60, 'UNIT_BLUEPRINTS constant must not be mutated');
});

// ── Max-level campaign blueprints do not pollute subsequent buildPvpBlueprints calls ─────────────────────

test('buildCampaignBlueprints at max level does not pollute subsequent buildPvpBlueprints', () => {
  buildCampaignBlueprints(makeCards(PVP_UNITS, UNIT_MAX_LEVEL)); // mutates internal clone; discard result

  const pvp = buildPvpBlueprints();
  for (const ut of PVP_UNITS) {
    assert.equal(pvp[ut].hp,          UNIT_BLUEPRINTS[ut].hp, `${ut}.hp after campaign call`);
    assert.equal(pvp[ut].armor  ?? 0, 0,                      `${ut} armor after campaign call`);
    assert.equal(pvp[ut].critPct ?? 0, 0,                     `${ut} critPct after campaign call`);
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
    assert.ok((campaign[ut].critPct      ?? 0) > 0, `${ut} should have critPct>0 in PvE at L9`);
    assert.ok((campaign[ut].lifestealPct ?? 0) > 0, `${ut} should have lifestealPct>0 in PvE at L9`);
    assert.equal(campaign[ut].spawnCount, UNIT_BLUEPRINTS[ut].spawnCount + 1, `${ut} should have +1 spawnCount at L9`);
    assert.equal(campaign[ut].armor ?? 0, 8, `${ut} should have armor=8 at L9`);
  }
});
