/**
 * sim/campaign.ts coverage gaps: spawnEnemyUnit's crossWaypoints assignment branch, and
 * hasLivingEnemyUnits/hasLivingAttackerUnits's "no living unit found" return-false path
 * (both are simple free functions over `ctx`, built directly via buildEngineCtx — no
 * need to drive a full engine/step() loop for these).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildEngineCtx } from '../engine/setup/buildCtx';
import { spawnEnemyUnit, hasLivingEnemyUnits, hasLivingAttackerUnits } from '../engine/sim/campaign';
import { resetUnitIds } from '../Unit';
import { UnitType, Side } from '../types';
import type { GameConfig } from '../types';
import type { LevelDefinition } from '../campaign/LevelDefinition';

function campaignConfig(seed: number): GameConfig {
  const level: LevelDefinition = {
    id: 'test_campaign_ctx',
    chapter: 0,
    seed,
    objective: { kind: 'survive' },
    waves: { entries: [] },
  };
  return { seed, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level };
}

test('spawnEnemyUnit assigns pendingWaypoints when crossWaypoints is non-empty', () => {
  resetUnitIds();
  const ctx = buildEngineCtx(campaignConfig(1));

  spawnEnemyUnit(ctx, UnitType.Runner, 0, false, [{ atRow: 5, toCol: 2 }]);

  const unit = Array.from(ctx.state.board.units.values())[0]!;
  assert.deepEqual(unit.pendingWaypoints, [{ atRow: 5, toCol: 2 }]);
});

test('spawnEnemyUnit leaves pendingWaypoints empty when crossWaypoints is omitted', () => {
  resetUnitIds();
  const ctx = buildEngineCtx(campaignConfig(2));

  spawnEnemyUnit(ctx, UnitType.Runner, 0);

  const unit = Array.from(ctx.state.board.units.values())[0]!;
  assert.deepEqual(unit.pendingWaypoints, []);
});

test('spawnEnemyUnit with isBoss registers the unit id in state.bossUnitIds', () => {
  resetUnitIds();
  const ctx = buildEngineCtx(campaignConfig(3));

  spawnEnemyUnit(ctx, UnitType.Runner, 0, true);

  const unit = Array.from(ctx.state.board.units.values())[0]!;
  assert.ok(ctx.state.bossUnitIds.has(unit.id));
  assert.equal(unit.isBoss, true);
});

test('hasLivingEnemyUnits returns false when the board has no Top-side units', () => {
  resetUnitIds();
  const ctx = buildEngineCtx(campaignConfig(4));
  assert.equal(hasLivingEnemyUnits(ctx), false, 'empty board → no living enemy units');
});

test('hasLivingEnemyUnits returns true once a living Top unit is spawned', () => {
  resetUnitIds();
  const ctx = buildEngineCtx(campaignConfig(5));
  spawnEnemyUnit(ctx, UnitType.Runner, 0);
  assert.equal(hasLivingEnemyUnits(ctx), true);
});

test('hasLivingAttackerUnits returns false when the board has no Bottom-side units', () => {
  resetUnitIds();
  const ctx = buildEngineCtx(campaignConfig(6));
  assert.equal(hasLivingAttackerUnits(ctx), false, 'empty board → no living attacker units');
});
