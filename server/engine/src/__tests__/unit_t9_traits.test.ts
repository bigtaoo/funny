/**
 * Per-unit T9 progression traits (ECONOMY_NUMBERS §4.4 "后期差异化路线", 2026-08-05).
 *
 * T3 (crit) / T6 (lifesteal) stay universal across all PROGRESSABLE_UNITS (see progression.ts
 * TRAIT_BREAKPOINTS doc comment); only T9 differs per unit via PER_UNIT_T9_TRAITS. This file
 * covers the two genuinely new combat mechanics (armor-enrage getter, reflect damage) plus the
 * applyUnitLevels wiring for all four differentiated units. Archer's range bonus and Max's
 * burstOnSingleMult bump are plain-field checks already covered by pvp_hardwall.test.ts's L9
 * test and don't need their own combat-simulation test.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { CombatSystem } from '../systems/CombatSystem';
import { UNIT_BLUEPRINTS } from '../config';
import { UnitType, Side } from '../types';
import { UNIT_MAX_LEVEL } from '../balance/progression';
import type { EngineCardInstance } from '../balance/equipment';
import { buildCampaignBlueprints } from '../balance/pveUpgrades';

function makeCards(units: readonly UnitType[], level: number): EngineCardInstance[] {
  return units.map((ut) => ({ id: `test_${ut}`, defId: ut, unitType: ut, level, gear: {} }));
}

// ── ShieldBearer: armor enrage (Unit.effectiveArmor getter) ─────────────────────────────────

test('Unit.effectiveArmor: armorEnrageBonus only applies below armorEnrageThreshold', () => {
  resetUnitIds();
  const bp = { ...UNIT_BLUEPRINTS[UnitType.ShieldBearer], armor: 5, armorEnrageThreshold: 0.4, armorEnrageBonus: 6 };
  const u = new Unit(UnitType.ShieldBearer, Side.Bottom, 0, 0, bp);

  // Full HP: enrage not active.
  assert.equal(u.effectiveArmor, 5, 'full HP should not enrage');

  // Just above threshold (41% > 40%): still not active.
  u.hp = Math.ceil(u.maxHp * 0.41);
  assert.equal(u.effectiveArmor, 5, 'just above threshold should not enrage');

  // Below threshold (39%): enrage active.
  u.hp = Math.floor(u.maxHp * 0.39);
  assert.equal(u.effectiveArmor, 11, 'below threshold should add armorEnrageBonus');
});

test('Unit.takeDamage uses effectiveArmor (enrage reduces incoming damage once triggered)', () => {
  resetUnitIds();
  const bp = { ...UNIT_BLUEPRINTS[UnitType.ShieldBearer], hp: 100, armor: 0, armorEnrageThreshold: 0.4, armorEnrageBonus: 6 };
  const u = new Unit(UnitType.ShieldBearer, Side.Bottom, 0, 0, bp);
  u.hp = 30; // 30% — below the 40% threshold

  const lost = u.takeDamage(10);
  assert.equal(lost, 4, 'armor 6 should reduce a 10-damage hit to 4');
});

// ── Lena: reflect damage (new CombatSystem mechanic) ────────────────────────────────────────

test('reflectPct (Lena T9): a defender with reflectPct bounces damage back onto the attacker', () => {
  const state  = new GameState(1);
  const combat = new CombatSystem();

  const attacker = new Unit(UnitType.Infantry, Side.Top, 5, 5, { ...UNIT_BLUEPRINTS[UnitType.Infantry], attack: 10 });
  // attack: 0 so the defender cannot land its own counter-hit this tick — isolates the reflect
  // effect from ordinary mutual combat (both units are in range 1 of each other).
  const defender = new Unit(UnitType.Lena, Side.Bottom, 5, 6, { ...UNIT_BLUEPRINTS[UnitType.Lena], attack: 0, armor: 0, reflectPct: 20 });

  state.board.addUnit(attacker);
  state.board.addUnit(defender);

  const attackerHpBefore = attacker.hp;
  combat.tick(state); // Infantry range 1, adjacent cells → attacks immediately.

  assert.ok(defender.hp < defender.maxHp, 'defender should have taken the primary hit');
  const actualDamageTaken = defender.maxHp - defender.hp;
  const expectedReflect = Math.floor(actualDamageTaken * 20 / 100);
  assert.equal(attackerHpBefore - attacker.hp, expectedReflect, 'attacker should lose 20% of the actual damage dealt');
});

test('reflectPct: no reflect when the trait is unset (regression guard — default path unaffected)', () => {
  const state  = new GameState(1);
  const combat = new CombatSystem();

  const attacker = new Unit(UnitType.Infantry, Side.Top, 5, 5, { ...UNIT_BLUEPRINTS[UnitType.Infantry], attack: 10 });
  const defender = new Unit(UnitType.Lena, Side.Bottom, 5, 6, { ...UNIT_BLUEPRINTS[UnitType.Lena], attack: 0, armor: 0 }); // reflectPct absent

  state.board.addUnit(attacker);
  state.board.addUnit(defender);

  const attackerHpBefore = attacker.hp;
  combat.tick(state);
  assert.equal(attacker.hp, attackerHpBefore, 'no reflectPct set → attacker takes no reflected damage');
});

// ── Max: burstOnSingleMult is honoured instead of the hardcoded ×2 ──────────────────────────

test('burstOnSingleMult: CombatSystem uses the per-unit multiplier, not a hardcoded ×2', () => {
  const state  = new GameState(1);
  const combat = new CombatSystem();

  const attacker = new Unit(UnitType.Max, Side.Top, 5, 5, {
    ...UNIT_BLUEPRINTS[UnitType.Max], attack: 10, burstOnSingle: true, burstOnSingleMult: 2.5,
  });
  const lastEnemy = new Unit(UnitType.Infantry, Side.Bottom, 5, 6, { ...UNIT_BLUEPRINTS[UnitType.Infantry], hp: 1000, armor: 0 });

  state.board.addUnit(attacker);
  state.board.addUnit(lastEnemy); // sole live unit on Bottom → burstOnSingle condition satisfied

  combat.tick(state);
  const actualDamage = lastEnemy.maxHp - lastEnemy.hp;
  assert.equal(actualDamage, 25, '10 attack × 2.5 burstOnSingleMult = 25');
});

// ── applyUnitLevels: PER_UNIT_T9_TRAITS wiring for all four differentiated units ────────────

test('applyUnitLevels at L9 applies each differentiated unit\'s own PER_UNIT_T9_TRAITS entry', () => {
  const campaign = buildCampaignBlueprints(makeCards(
    [UnitType.Archer, UnitType.ShieldBearer, UnitType.Lena, UnitType.Mara, UnitType.Max, UnitType.Infantry],
    UNIT_MAX_LEVEL,
  ));

  assert.equal(campaign[UnitType.Archer].range, UNIT_BLUEPRINTS[UnitType.Archer].range + 1, 'Archer range+1 at L9');

  assert.equal(campaign[UnitType.ShieldBearer].armorEnrageThreshold, 0.4);
  assert.equal(campaign[UnitType.ShieldBearer].armorEnrageBonus, 6);
  assert.equal(campaign[UnitType.ShieldBearer].spawnCount, UNIT_BLUEPRINTS[UnitType.ShieldBearer].spawnCount,
    'ShieldBearer must NOT also get the generic +1 spawn at L9');

  assert.equal(campaign[UnitType.Lena].reflectPct, 20);
  assert.equal(campaign[UnitType.Lena].spawnCount, UNIT_BLUEPRINTS[UnitType.Lena].spawnCount);

  assert.deepEqual(campaign[UnitType.Mara].slowOnHit, { mult: 0.8, durationSec: 1.5 });
  assert.equal(campaign[UnitType.Mara].spawnCount, UNIT_BLUEPRINTS[UnitType.Mara].spawnCount);

  assert.equal(campaign[UnitType.Max].burstOnSingleMult, 2.5);
  assert.equal(campaign[UnitType.Max].spawnCount, UNIT_BLUEPRINTS[UnitType.Max].spawnCount);

  // Infantry has no PER_UNIT_T9_TRAITS entry → keeps the generic fallback.
  assert.equal(campaign[UnitType.Infantry].spawnCount, UNIT_BLUEPRINTS[UnitType.Infantry].spawnCount + 1);
});

test('PER_UNIT_T9_TRAITS effects do not apply before L9', () => {
  const campaign = buildCampaignBlueprints(makeCards([UnitType.Archer, UnitType.ShieldBearer, UnitType.Lena, UnitType.Mara, UnitType.Max], 8));
  assert.equal(campaign[UnitType.Archer].range, UNIT_BLUEPRINTS[UnitType.Archer].range);
  assert.equal(campaign[UnitType.ShieldBearer].armorEnrageThreshold ?? 0, 0);
  assert.equal(campaign[UnitType.Lena].reflectPct ?? 0, 0);
  assert.equal(campaign[UnitType.Mara].slowOnHit ?? null, null, 'Mara has no base slowOnHit before L9');
  assert.equal(campaign[UnitType.Max].burstOnSingleMult ?? 2, 2);
});
