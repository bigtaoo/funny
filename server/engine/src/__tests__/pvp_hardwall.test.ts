/**
 * S12 PvP hard-wall tests (A2 acceptance).
 *
 * Core invariant: buildPvpBlueprints() must return a clone that is word-for-word equal to UNIT_BLUEPRINTS,
 * meaning no trait / armor / equipment stat from any campaign/siege path can leak into PvP blueprints.
 * This is the runtime guard for "PvP fairness hard line §5.2": a failing test means something has leaked into PvP.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { UNIT_BLUEPRINTS } from '../config';
import { buildPvpBlueprints, buildCampaignBlueprints } from '../balance/pveUpgrades';
import { UNIT_MAX_LEVEL } from '../balance/progression';
import { UnitType } from '../types';

const PVP_UNITS = [UnitType.Infantry, UnitType.ShieldBearer, UnitType.Archer] as const;

// ── buildPvpBlueprints is word-for-word equal to the UNIT_BLUEPRINTS constants ─────────────────────────

test('buildPvpBlueprints: all PvP unit blueprints exactly equal UNIT_BLUEPRINTS constants', () => {
  const pvp = buildPvpBlueprints();
  for (const ut of PVP_UNITS) {
    const ref = UNIT_BLUEPRINTS[ut];
    const got = pvp[ut];
    // Check all numeric stat fields are identical.
    assert.equal(got.hp,             ref.hp,             `${ut}.hp`);
    assert.equal(got.attack,         ref.attack,         `${ut}.attack`);
    assert.equal(got.attackInterval, ref.attackInterval, `${ut}.attackInterval`);
    assert.equal(got.speed,          ref.speed,          `${ut}.speed`);
    assert.equal(got.range,          ref.range,          `${ut}.range`);
    assert.equal(got.spawnCount,     ref.spawnCount,     `${ut}.spawnCount`);
    // Trait fields that MUST stay at baseline (0 / undefined) in PvP.
    assert.equal(got.armor       ?? 0, 0, `${ut} PvP armor must be 0`);
    assert.equal(got.critPct     ?? 0, 0, `${ut} PvP critPct must be 0`);
    assert.equal(got.lifestealPct ?? 0, 0, `${ut} PvP lifestealPct must be 0`);
  }
});

// ── PvP blueprints are independent clones (mutating them does not affect the global constant) ───────

test('buildPvpBlueprints: returned object is a clone, not the global constant', () => {
  const pvp = buildPvpBlueprints();
  pvp[UnitType.Infantry].hp = 9999; // mutate the clone
  // The global constant must be unaffected.
  assert.equal(UNIT_BLUEPRINTS[UnitType.Infantry].hp, 60, 'UNIT_BLUEPRINTS constant must not be mutated');
});

// ── Max-level campaign blueprints do not pollute subsequent buildPvpBlueprints calls ─────────────────────

test('buildCampaignBlueprints at max level does not pollute subsequent buildPvpBlueprints', () => {
  // Build a campaign blueprint with all units at max level.
  const maxLevels: Record<string, number> = {};
  for (const ut of PVP_UNITS) maxLevels[ut] = UNIT_MAX_LEVEL;
  buildCampaignBlueprints({}, undefined, maxLevels); // mutates internal clone; discard result

  // PvP blueprint must still return unmodified constants.
  const pvp = buildPvpBlueprints();
  for (const ut of PVP_UNITS) {
    assert.equal(pvp[ut].hp,         UNIT_BLUEPRINTS[ut].hp,         `${ut}.hp after campaign call`);
    assert.equal(pvp[ut].armor ?? 0, 0,                              `${ut} armor after campaign call`);
    assert.equal(pvp[ut].critPct ?? 0, 0,                            `${ut} critPct after campaign call`);
  }
});

// ── PvP path does not inject unit levels (spawnCount unchanged) ───────────────────────────────────

test('buildPvpBlueprints: spawnCount equals UNIT_BLUEPRINTS (no T9 +1 spawn leak)', () => {
  const pvp = buildPvpBlueprints();
  for (const ut of PVP_UNITS) {
    assert.equal(
      pvp[ut].spawnCount,
      UNIT_BLUEPRINTS[ut].spawnCount,
      `${ut} spawnCount must match base blueprint in PvP`,
    );
  }
});

// ── Max-level campaign blueprints confirm trait thresholds are active (contrast test: PvE progression actually works) ──

test('buildCampaignBlueprints at level 9: traits are applied (contrast: PvE path works)', () => {
  const maxLevels: Record<string, number> = {};
  for (const ut of PVP_UNITS) maxLevels[ut] = UNIT_MAX_LEVEL;

  const campaign = buildCampaignBlueprints({}, undefined, maxLevels);
  for (const ut of PVP_UNITS) {
    // T3 crit should be active (level 9 >= 3)
    assert.ok((campaign[ut].critPct ?? 0) > 0,      `${ut} should have critPct>0 in PvE at L9`);
    // T6 lifesteal should be active (level 9 >= 6)
    assert.ok((campaign[ut].lifestealPct ?? 0) > 0, `${ut} should have lifestealPct>0 in PvE at L9`);
    // T9 +1 spawn should be active (level 9 >= 9)
    assert.equal(
      campaign[ut].spawnCount,
      UNIT_BLUEPRINTS[ut].spawnCount + 1,
      `${ut} should have +1 spawnCount in PvE at L9`,
    );
    // Armor from progression: steps = 8, armor = 8 × 1 = 8
    assert.equal(campaign[ut].armor ?? 0, 8, `${ut} should have armor=8 in PvE at L9`);
  }
});
