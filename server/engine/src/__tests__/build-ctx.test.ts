/**
 * Direct unit coverage for engine/setup/buildCtx.ts's buildEngineCtx — the top-level
 * orchestrator that assembles an EngineCtx from a GameConfig. The PvP-shaped (mode
 * omitted / 'pvp' / 'netplay') and PvE-shaped-with-a-level ('campaign' / 'siege') paths
 * are already exercised end-to-end via createGameEngine in other test files, but no
 * existing test ever calls a PvE-shaped mode WITHOUT a level — the one branch (the
 * `if (!config.level) throw` guard) that was still uncovered.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildEngineCtx } from '../engine/setup/buildCtx';
import type { GameConfig } from '../types';
import type { LevelDefinition } from '../campaign/LevelDefinition';

test('buildEngineCtx: default (mode omitted) builds a PvP-shaped ctx with nulled PvE fields', () => {
  const ctx = buildEngineCtx({ seed: 1, players: [{ id: 0 }, { id: 1 }] });
  assert.equal(ctx.mode, 'pvp');
  assert.equal(ctx.level, null);
  assert.equal(ctx.waveDirector, null);
  assert.deepEqual(ctx.initialSpellCards, []);
  assert.deepEqual(ctx.garrisonUnits, []);
  assert.deepEqual(ctx.attackerArmyUnits, []);
  assert.deepEqual(ctx.defenderBuildingList, []);
});

test('buildEngineCtx: netplay mode is also PvP-shaped (no WaveDirector, no level required)', () => {
  const ctx = buildEngineCtx({ seed: 2, players: [{ id: 0 }, { id: 1 }], mode: 'netplay' });
  assert.equal(ctx.mode, 'netplay');
  assert.equal(ctx.level, null);
  assert.equal(ctx.waveDirector, null);
});

test('buildEngineCtx: campaign mode without a level definition throws', () => {
  const config: GameConfig = { seed: 3, players: [{ id: 0 }, { id: 1 }], mode: 'campaign' };
  assert.throws(() => buildEngineCtx(config), /campaign mode requires a level definition/);
});

test('buildEngineCtx: siege mode without a level definition throws (mode name interpolated into the message)', () => {
  const config: GameConfig = { seed: 4, players: [{ id: 0 }, { id: 1 }], mode: 'siege' };
  assert.throws(() => buildEngineCtx(config), /siege mode requires a level definition/);
});

test('buildEngineCtx: campaign mode with a level builds a full PvE ctx (WaveDirector + pre-placed lists)', () => {
  const level: LevelDefinition = {
    id: 'test_ctx_level',
    chapter: 0,
    seed: 5,
    objective: { kind: 'survive' },
    waves: { entries: [] },
  };
  const config: GameConfig = { seed: 5, players: [{ id: 0 }, { id: 1 }], mode: 'campaign', level };
  const ctx = buildEngineCtx(config);
  assert.equal(ctx.mode, 'campaign');
  assert.equal(ctx.level, level);
  assert.ok(ctx.waveDirector, 'campaign ctx must build a WaveDirector');
  assert.ok(Array.isArray(ctx.garrisonUnits));
  assert.ok(Array.isArray(ctx.attackerArmyUnits));
  assert.ok(Array.isArray(ctx.defenderBuildingList));
});
