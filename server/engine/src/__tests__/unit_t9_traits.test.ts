/**
 * Per-unit T9 progression traits (ECONOMY_NUMBERS §4.4 "后期差异化路线", 2026-08-05).
 *
 * T3 (crit) / T6 (lifesteal) stay universal across all PROGRESSABLE_UNITS (see progression.ts
 * TRAIT_BREAKPOINTS doc comment); only T9 differs per unit via PER_UNIT_T9_TRAITS. This file
 * covers all five differentiated units end-to-end: not just the blueprint-field wiring
 * (applyUnitLevels), but each one's actual runtime effect in combat — including two follow-up
 * gaps found in a 2026-08-05 coverage pass: reflectPct bouncing damage onto a *Building*
 * attacker (arrow tower), not just a Unit attacker, and the armor-enrage interaction with the
 * equipment-armor cap (EFFECT_CAPS.armorFlat) — enrage is intentionally NOT subject to that cap,
 * since it's a dynamic runtime getter applied after clampEffectCaps already ran, not another
 * static source summed into it.
 *
 * ADR-065: hp/attack/armor/reflectPct/armorEnrageThreshold/armorEnrageBonus/burstOnSingleMult/
 * slowOnHit.mult are fp (scale = FP_SCALE = 1000) — every literal below goes through toFp()
 * rather than a bare scaled integer.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { Building, resetBuildingIds } from '../Building';
import { CombatSystem } from '../systems/CombatSystem';
import { UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '../config';
import { UnitType, BuildingType, Side } from '../types';
import { UNIT_MAX_LEVEL } from '../balance/progression';
import { EFFECT_CAPS, type EngineCardInstance } from '../balance/equipment';
import { buildCampaignBlueprints } from '../balance/pveUpgrades';
import { toFp, fp, mulFp, addFp, divFpByInt } from '../math/fixed';

function makeCards(units: readonly UnitType[], level: number): EngineCardInstance[] {
  return units.map((ut) => ({ id: `test_${ut}`, defId: ut, unitType: ut, level, gear: {} }));
}

// ── ShieldBearer: armor enrage (Unit.effectiveArmor getter) ─────────────────────────────────

test('Unit.effectiveArmor: armorEnrageBonus only applies below armorEnrageThreshold', () => {
  resetUnitIds();
  const bp = { ...UNIT_BLUEPRINTS[UnitType.ShieldBearer], armor_fp: toFp(5), armorEnrageThreshold_fp: toFp(0.4), armorEnrageBonus_fp: toFp(6) };
  const u = new Unit(UnitType.ShieldBearer, Side.Bottom, 0, 0, bp);

  // Full HP: enrage not active.
  assert.equal(u.effectiveArmor, toFp(5), 'full HP should not enrage');

  // Just above threshold (41% > 40%): still not active.
  u.hp_fp = fp(Math.ceil(u.maxHp_fp * 0.41));
  assert.equal(u.effectiveArmor, toFp(5), 'just above threshold should not enrage');

  // Below threshold (39%): enrage active.
  u.hp_fp = fp(Math.floor(u.maxHp_fp * 0.39));
  assert.equal(u.effectiveArmor, toFp(11), 'below threshold should add armorEnrageBonus');
});

test('Unit.takeDamage uses effectiveArmor (enrage reduces incoming damage once triggered)', () => {
  resetUnitIds();
  const bp = { ...UNIT_BLUEPRINTS[UnitType.ShieldBearer], hp_fp: toFp(100), armor_fp: toFp(0), armorEnrageThreshold_fp: toFp(0.4), armorEnrageBonus_fp: toFp(6) };
  const u = new Unit(UnitType.ShieldBearer, Side.Bottom, 0, 0, bp);
  u.hp_fp = toFp(30); // 30% — below the 40% threshold

  const lost = u.takeDamage(toFp(10));
  assert.equal(lost, toFp(4), 'armor 6 should reduce a 10-damage hit to 4');
});

test('armor-enrage is layered on top of the already-capped equipment armor, not itself capped (documents the actual combined ceiling)', () => {
  resetUnitIds();
  // EFFECT_CAPS.armorFlat_fp's doc comment says the *intended* combined ceiling (progression + equipment)
  // is ~20 (progression L9 = +8, equipment cap = 12). `bp.armor_fp` here stands in for that already-
  // clamped post-equipment value (clampEffectCaps runs long before Unit construction) — enrage adds
  // on top of it at runtime via a separate getter, so the combined total during enrage legitimately
  // exceeds that documented ceiling. This test pins the actual number so a future change to either
  // cap doesn't silently shift this without someone noticing.
  const cappedArmor_fp = addFp(EFFECT_CAPS.armorFlat_fp, toFp(8)); // equipment cap + L9 progression armor
  const bp = { ...UNIT_BLUEPRINTS[UnitType.ShieldBearer], armor_fp: cappedArmor_fp, armorEnrageThreshold_fp: toFp(0.4), armorEnrageBonus_fp: toFp(6) };
  const u = new Unit(UnitType.ShieldBearer, Side.Bottom, 0, 0, bp);

  assert.equal(u.effectiveArmor, cappedArmor_fp, 'full HP: no enrage, armor is exactly the capped value');
  u.hp_fp = fp(Math.floor(u.maxHp_fp * 0.39));
  assert.equal(u.effectiveArmor, cappedArmor_fp + toFp(6), 'enraged: combined armor exceeds the documented ~20 ceiling by design');
});

// ── Lena: reflect damage (new CombatSystem mechanic) ────────────────────────────────────────

test('reflectPct (Lena T9): a defender with reflectPct bounces damage back onto the attacker', () => {
  const state  = new GameState(1);
  const combat = new CombatSystem();

  const attacker = new Unit(UnitType.Infantry, Side.Top, 5, 5, { ...UNIT_BLUEPRINTS[UnitType.Infantry], attack_fp: toFp(10) });
  // attack: 0 so the defender cannot land its own counter-hit this tick — isolates the reflect
  // effect from ordinary mutual combat (both units are in range 1 of each other).
  const defender = new Unit(UnitType.Lena, Side.Bottom, 5, 6, { ...UNIT_BLUEPRINTS[UnitType.Lena], attack_fp: toFp(0), armor_fp: toFp(0), reflectPct_fp: toFp(20) });

  state.board.addUnit(attacker);
  state.board.addUnit(defender);

  const attackerHpBefore = attacker.hp_fp;
  combat.tick(state); // Infantry range 1, adjacent cells → attacks immediately.

  assert.ok(defender.hp_fp < defender.maxHp_fp, 'defender should have taken the primary hit');
  const actualDamageTaken = defender.maxHp_fp - defender.hp_fp;
  const expectedReflect = divFpByInt(mulFp(fp(actualDamageTaken), toFp(20)), 100);
  assert.equal(attackerHpBefore - attacker.hp_fp, expectedReflect, 'attacker should lose 20% of the actual damage dealt');
});

test('reflectPct (Lena T9): also bounces damage back onto a Building attacker (arrow tower), not just a Unit', () => {
  // performBuildingAttack's payload carries the *building's* id as attackerId — resolveAttackHit's
  // reflect branch must fall back to state.board.buildings.get() when the unit lookup misses,
  // covering the code path CombatSystem.ts explicitly special-cases for this.
  resetUnitIds();
  resetBuildingIds();
  const state  = new GameState(1);
  const combat = new CombatSystem();

  const defender = new Unit(UnitType.Lena, Side.Top, 5, 5, { ...UNIT_BLUEPRINTS[UnitType.Lena], armor_fp: toFp(0), reflectPct_fp: toFp(20) });
  state.board.addUnit(defender);
  // Bottom arrow tower within its own attackRange (2 cells) of the Top defender; Lena's own range
  // (1, melee) can't reach 2 cells away, so she never counter-attacks — isolates the reflect effect.
  const tower = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 3, { ...BUILDING_BLUEPRINTS[BuildingType.ArrowTower], attack_fp: toFp(15) });
  state.board.addBuilding(tower);

  const towerHpBefore = tower.hp_fp;
  for (let i = 0; i < 200; i++) {
    combat.tick(state);
    state.elapsedTicks++;
    if (defender.hp_fp < defender.maxHp_fp) break;
  }

  assert.ok(defender.hp_fp < defender.maxHp_fp, 'defender should have taken the tower\'s hit');
  const actualDamageTaken = defender.maxHp_fp - defender.hp_fp;
  const expectedReflect = divFpByInt(mulFp(fp(actualDamageTaken), toFp(20)), 100);
  assert.ok(expectedReflect > 0, 'test setup sanity: reflect must be non-zero to be observable');
  assert.equal(towerHpBefore - tower.hp_fp, expectedReflect, 'tower should lose 20% of the actual damage it dealt');
});

test('reflectPct: no reflect when the trait is unset (regression guard — default path unaffected)', () => {
  const state  = new GameState(1);
  const combat = new CombatSystem();

  const attacker = new Unit(UnitType.Infantry, Side.Top, 5, 5, { ...UNIT_BLUEPRINTS[UnitType.Infantry], attack_fp: toFp(10) });
  const defender = new Unit(UnitType.Lena, Side.Bottom, 5, 6, { ...UNIT_BLUEPRINTS[UnitType.Lena], attack_fp: toFp(0), armor_fp: toFp(0) }); // reflectPct absent

  state.board.addUnit(attacker);
  state.board.addUnit(defender);

  const attackerHpBefore = attacker.hp_fp;
  combat.tick(state);
  assert.equal(attacker.hp_fp, attackerHpBefore, 'no reflectPct set → attacker takes no reflected damage');
});

// ── Max: burstOnSingleMult is honoured instead of the hardcoded ×2 ──────────────────────────

test('burstOnSingleMult: CombatSystem uses the per-unit multiplier, not a hardcoded ×2', () => {
  const state  = new GameState(1);
  const combat = new CombatSystem();

  const attacker = new Unit(UnitType.Max, Side.Top, 5, 5, {
    ...UNIT_BLUEPRINTS[UnitType.Max], attack_fp: toFp(10), burstOnSingle: true, burstOnSingleMult_fp: toFp(2.5),
  });
  const lastEnemy = new Unit(UnitType.Infantry, Side.Bottom, 5, 6, { ...UNIT_BLUEPRINTS[UnitType.Infantry], hp_fp: toFp(1000), armor_fp: toFp(0) });

  state.board.addUnit(attacker);
  state.board.addUnit(lastEnemy); // sole live unit on Bottom → burstOnSingle condition satisfied

  combat.tick(state);
  const actualDamage = lastEnemy.maxHp_fp - lastEnemy.hp_fp;
  assert.equal(actualDamage, toFp(25), '10 attack × 2.5 burstOnSingleMult = 25');
});

// ── Mara: T9 slowOnHit actually slows the target in combat (not just a blueprint-field check) ──

test('slowOnHit (Mara T9): a hit target\'s speed actually drops, not just the blueprint field being set', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const combat = new CombatSystem();

  const attacker = new Unit(UnitType.Mara, Side.Top, 5, 3, {
    ...UNIT_BLUEPRINTS[UnitType.Mara], attack_fp: toFp(10), slowOnHit: { mult_fp: toFp(0.8), durationSec: 1.5 },
  });
  const target = new Unit(UnitType.Infantry, Side.Bottom, 5, 5, { ...UNIT_BLUEPRINTS[UnitType.Infantry], armor_fp: toFp(0) });
  state.board.addUnit(attacker);
  state.board.addUnit(target);

  const baseSpeed = target.speed_fp;
  assert.equal(target.slowRemainingTicks, 0, 'not slowed yet');

  // Mara range 2, projectile-based — needs the shot to actually land, not just fire.
  for (let i = 0; i < 60; i++) {
    combat.tick(state);
    state.elapsedTicks++;
    if (target.slowRemainingTicks > 0) break;
  }

  assert.ok(target.slowRemainingTicks > 0, 'target should be under the slow debuff after being hit');
  assert.equal(target.speed_fp, mulFp(baseSpeed, toFp(0.8)), 'speed should be reduced to 80% of base');
});

// ── Archer: T9 range+1 actually lets it engage a target the base range could not reach ─────────

test('range bonus (Archer T9): a target only reachable at range 3 is engaged, not ignored', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const combat = new CombatSystem();

  const baseRange = UNIT_BLUEPRINTS[UnitType.Archer].range; // 2
  const leveledArcher = new Unit(UnitType.Archer, Side.Top, 5, 3, {
    ...UNIT_BLUEPRINTS[UnitType.Archer], attack_fp: toFp(10), range: baseRange + 1,
  });
  // Distance 3 (row 3 → row 6): reachable at range 3 (T9), NOT at the base range 2.
  const target = new Unit(UnitType.Infantry, Side.Bottom, 5, 6, { ...UNIT_BLUEPRINTS[UnitType.Infantry], armor_fp: toFp(0), attack_fp: toFp(0) });
  state.board.addUnit(leveledArcher);
  state.board.addUnit(target);

  const targetHpBefore = target.hp_fp;
  for (let i = 0; i < 60; i++) {
    combat.tick(state);
    state.elapsedTicks++;
    if (target.hp_fp < targetHpBefore) break;
  }

  assert.ok(target.hp_fp < targetHpBefore, 'target 3 cells away should be engaged by a range-3 archer');
});

test('range bonus: the same distance is NOT reachable at the un-leveled base range (sanity control for the test above)', () => {
  resetUnitIds();
  const state  = new GameState(1);
  const combat = new CombatSystem();

  const baseArcher = new Unit(UnitType.Archer, Side.Top, 5, 3, { ...UNIT_BLUEPRINTS[UnitType.Archer], attack_fp: toFp(10) }); // range stays 2
  const target = new Unit(UnitType.Infantry, Side.Bottom, 5, 6, { ...UNIT_BLUEPRINTS[UnitType.Infantry], armor_fp: toFp(0), attack_fp: toFp(0) });
  state.board.addUnit(baseArcher);
  state.board.addUnit(target);

  const targetHpBefore = target.hp_fp;
  // Freeze both units in place (no movement system) — if range alone doesn't reach, nothing should happen.
  for (let i = 0; i < 60; i++) {
    combat.tick(state);
    state.elapsedTicks++;
  }

  assert.equal(target.hp_fp, targetHpBefore, 'a base-range archer 3 cells away should never engage (control for the range+1 test)');
});

// ── applyUnitLevels: PER_UNIT_T9_TRAITS wiring for all four differentiated units ────────────

test('applyUnitLevels at L9 applies each differentiated unit\'s own PER_UNIT_T9_TRAITS entry', () => {
  const campaign = buildCampaignBlueprints(makeCards(
    [UnitType.Archer, UnitType.ShieldBearer, UnitType.Lena, UnitType.Mara, UnitType.Max, UnitType.Infantry],
    UNIT_MAX_LEVEL,
  ));

  assert.equal(campaign[UnitType.Archer].range, UNIT_BLUEPRINTS[UnitType.Archer].range + 1, 'Archer range+1 at L9');

  assert.equal(campaign[UnitType.ShieldBearer].armorEnrageThreshold_fp, toFp(0.4));
  assert.equal(campaign[UnitType.ShieldBearer].armorEnrageBonus_fp, toFp(6));
  assert.equal(campaign[UnitType.ShieldBearer].spawnCount, UNIT_BLUEPRINTS[UnitType.ShieldBearer].spawnCount,
    'ShieldBearer must NOT also get the generic +1 spawn at L9');

  assert.equal(campaign[UnitType.Lena].reflectPct_fp, toFp(20));
  assert.equal(campaign[UnitType.Lena].spawnCount, UNIT_BLUEPRINTS[UnitType.Lena].spawnCount);

  assert.deepEqual(campaign[UnitType.Mara].slowOnHit, { mult_fp: toFp(0.8), durationSec: 1.5 });
  assert.equal(campaign[UnitType.Mara].spawnCount, UNIT_BLUEPRINTS[UnitType.Mara].spawnCount);

  assert.equal(campaign[UnitType.Max].burstOnSingleMult_fp, toFp(2.5));
  assert.equal(campaign[UnitType.Max].spawnCount, UNIT_BLUEPRINTS[UnitType.Max].spawnCount);

  // Infantry has no PER_UNIT_T9_TRAITS entry → keeps the generic fallback.
  assert.equal(campaign[UnitType.Infantry].spawnCount, UNIT_BLUEPRINTS[UnitType.Infantry].spawnCount + 1);
});

test('PER_UNIT_T9_TRAITS effects do not apply before L9', () => {
  const campaign = buildCampaignBlueprints(makeCards([UnitType.Archer, UnitType.ShieldBearer, UnitType.Lena, UnitType.Mara, UnitType.Max], 8));
  assert.equal(campaign[UnitType.Archer].range, UNIT_BLUEPRINTS[UnitType.Archer].range);
  assert.equal(campaign[UnitType.ShieldBearer].armorEnrageThreshold_fp ?? toFp(0), toFp(0));
  assert.equal(campaign[UnitType.Lena].reflectPct_fp ?? toFp(0), toFp(0));
  assert.equal(campaign[UnitType.Mara].slowOnHit ?? null, null, 'Mara has no base slowOnHit before L9');
  assert.equal(campaign[UnitType.Max].burstOnSingleMult_fp ?? toFp(2), toFp(2));
});
