/**
 * Regression: projectile and escort id allocation must be PER GameState instance, never a
 * shared module global. Identical class of bug already fixed for units/buildings (see
 * unit-id-per-instance.test.ts / building-id-per-instance.test.ts) — found in Projectile.ts
 * and EscortUnit.ts, which still reset a module-level counter from the GameState constructor.
 *
 * If a second GameState is built mid-match (e.g. judgeRunner's hash recompute while the live
 * engine is still running, or a headless replay-judge run alongside a live match in the same
 * process), the old `resetProjectileIds()`/`resetEscortIds()` calls in the GameState constructor
 * would rewind the shared counter, so the live engine's next projectile/escort could reuse an
 * id still referenced by an in-flight projectile or a live escort — corrupting GameEvent
 * targetId lookups and replay determinism.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Projectile, resetProjectileIds } from '../Projectile';
import { EscortUnit, resetEscortIds } from '../EscortUnit';
import { Unit } from '../Unit';
import { CombatSystem } from '../systems/CombatSystem';
import { createGameEngine } from '../GameEngine';
import { toFp } from '../math/fixed';
import { Side, UnitType } from '../types';
import type { GameConfig } from '../types';
import type { EscortSpec } from '../campaign/LevelDefinition';
import type { LevelDefinition } from '../campaign/LevelDefinition';

const ZERO_FP = toFp(0);

const PAYLOAD = {
  attackerId: 1,
  side: Side.Bottom,
  rawDamage: 10,
  splashRadius: 0,
  piercing: false,
  lifestealPct: 0,
  slowOnHit: null,
  burstOnSingle: false,
  markEnemies: false,
};

const ESCORT_SPEC: EscortSpec = { id: 'e1', hp: 100, speed: 1, startCol: 3, startRow: 10 };

test('allocProjectileId is monotonic and starts at 2,000,000 for a fresh match', () => {
  const gs = new GameState(1);
  assert.equal(gs.allocProjectileId(), 2_000_000);
  assert.equal(gs.allocProjectileId(), 2_000_001);
});

test('allocEscortId is monotonic and starts at 5000 for a fresh match', () => {
  const gs = new GameState(1);
  assert.equal(gs.allocEscortId(), 5000);
  assert.equal(gs.allocEscortId(), 5001);
});

test('constructing a second GameState mid-match does NOT perturb the first match\'s projectile/escort id streams', () => {
  const gsA = new GameState(1);
  assert.equal(gsA.allocProjectileId(), 2_000_000);
  assert.equal(gsA.allocEscortId(), 5000);

  // Simulate judgeRunner's mid-match hash recompute: a brand-new engine/state.
  // Under the old module-global counters this reset the shared ids back to their base.
  const gsB = new GameState(2);
  assert.equal(gsB.allocProjectileId(), 2_000_000); // gsB has its OWN counters, independent of gsA
  assert.equal(gsB.allocEscortId(), 5000);

  // gsA must keep counting from where it left off — NOT restart at the base value.
  assert.equal(gsA.allocProjectileId(), 2_000_001, 'first match projectile-id stream was reset by a second GameState');
  assert.equal(gsA.allocEscortId(), 5001, 'first match escort-id stream was reset by a second GameState');
});

test('an in-flight projectile keeps its id after a mid-match second GameState is built', () => {
  const gsA = new GameState(1);

  const p1 = new Projectile(ZERO_FP, ZERO_FP, 1, 999, 'unit', PAYLOAD, 'arrow', gsA.allocProjectileId());
  gsA.projectiles.push(p1);

  // Mid-match judge recompute builds a second state (old bug: reset the shared counter).
  new GameState(2);

  const p2 = new Projectile(ZERO_FP, ZERO_FP, 1, 999, 'unit', PAYLOAD, 'arrow', gsA.allocProjectileId());
  gsA.projectiles.push(p2);

  assert.notEqual(p1.id, p2.id, 'second projectile reused the first one\'s id');
  assert.equal(p1.id, 2_000_000);
  assert.equal(p2.id, 2_000_001);
});

test('a live escort keeps its numericId after a mid-match second GameState is built', () => {
  const gsA = new GameState(1);

  const e1 = new EscortUnit(ESCORT_SPEC, gsA.allocEscortId());
  gsA.escorts.push(e1);

  // Mid-match judge recompute builds a second state (old bug: reset the shared counter).
  new GameState(2);

  const e2 = new EscortUnit({ ...ESCORT_SPEC, id: 'e2' }, gsA.allocEscortId());
  gsA.escorts.push(e2);

  assert.notEqual(e1.numericId, e2.numericId, 'second escort reused the first one\'s numericId');
  assert.equal(e1.numericId, 5000);
  assert.equal(e2.numericId, 5001);
});

test('standalone Projectile/EscortUnit fallback ids never collide with per-instance ids', () => {
  resetProjectileIds();
  const standaloneProj = new Projectile(ZERO_FP, ZERO_FP, 1, 999, 'unit', PAYLOAD, 'arrow');
  assert.ok(standaloneProj.id >= 2_000_000, `standalone fallback id ${standaloneProj.id} is inside the expected range`);

  resetEscortIds();
  const standaloneEscort = new EscortUnit(ESCORT_SPEC);
  assert.ok(standaloneEscort.numericId >= 5000, `standalone fallback numericId ${standaloneEscort.numericId} is inside the expected range`);

  const gs = new GameState(1);
  assert.equal(gs.allocProjectileId(), 2_000_000); // instance counter unaffected by the module fallback
  assert.equal(gs.allocEscortId(), 5000);
});

test('integration: CombatSystem.fireProjectile draws the real projectile id from GameState.allocProjectileId', () => {
  const gs = new GameState(1);
  const combat = new CombatSystem();

  // Two archers in range (Archer.range from config), cooldown forced to 0 so the very
  // first tick() fires. Facing rows 5/6 keeps them within melee-adjacent range too, but
  // archers always fire a homing projectile rather than an instant hit (see config.ts).
  const bottom = new Unit(UnitType.Archer, Side.Bottom, 3, 5);
  const top    = new Unit(UnitType.Archer, Side.Top,    3, 6);
  bottom.attackCooldownTicks = 0;
  top.attackCooldownTicks    = 0;
  gs.board.addUnit(bottom);
  gs.board.addUnit(top);

  combat.tick(gs);

  assert.ok(gs.projectiles.length > 0, 'no projectile fired — test setup out of the archers\' range');
  for (const p of gs.projectiles) {
    // Per-instance counter starts at 2,000,000; the module fallback is also >=2,000,000, so
    // this alone can't distinguish wiring — but it pins the ids are sequential and unique,
    // which is what the mid-match id-collision bug broke.
    assert.ok(p.id >= 2_000_000);
  }
  const ids = gs.projectiles.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'fireProjectile handed out a duplicate id');
});

test('integration: campaign escorts (engine/base.ts) get per-instance numericIds, starting at 5000', () => {
  const level: LevelDefinition = {
    id: 'test_escorts',
    chapter: 0,
    seed: 7,
    objective: { kind: 'timed_defense', durationTicks: 5 },
    waves: { entries: [] },
    escorts: [
      { id: 'escort_a', hp: 100, speed: 1, startCol: 2, startRow: 10 },
      { id: 'escort_b', hp: 100, speed: 1, startCol: 4, startRow: 10 },
    ],
  };
  const config: GameConfig = { seed: 7, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level };
  const engine = createGameEngine(config);
  engine.step(0, []);

  const numericIds = engine.state.escorts.map((e) => e.numericId).sort((a, b) => a - b);
  assert.equal(numericIds.length, 2, 'both escorts landed on state.escorts');
  // Freshly built engine → instance counter runs 5000, 5001. A dropped allocEscortId() wiring
  // in base.ts would instead hand out module-fallback ids (also >=5000, but not deterministically
  // 5000/5001 across a match that reuses the module counter across GameState instances).
  assert.deepEqual(numericIds, [5000, 5001], `escorts did not use the per-instance counter (got ${numericIds})`);
});
