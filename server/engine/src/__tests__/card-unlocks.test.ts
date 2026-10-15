/**
 * Level `cardUnlocks`, `assistOnLoss` / applyAssist and the campaign content revision
 * (ONBOARDING_DESIGN §17.1–17.2).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createGameEngine } from '../GameEngine';
import { UniformCardDrawPolicy, TutorialDrawPolicy } from '../Card';
import { CARD_DEFINITIONS } from '../config';
import { Prng } from '../math/prng';
import { applyAssist, ASSIST_BONUS_INK, ASSIST_ENEMY_SCALE } from '../campaign/assist';
import { CAMPAIGN_CONTENT_REV, hasLevelContent, levelContentRev } from '../campaign/contentRev';
import { parseLevelDefinition, LevelParseError } from '../campaign/levelSchema';
import { UnitType } from '../types';
import type { GameConfig } from '../types';
import type { LevelDefinition } from '../campaign/LevelDefinition';

const def = (id: string) => CARD_DEFINITIONS.find((c) => c.id === id)!;

test('UniformCardDrawPolicy.unlock: the unlocked card is the next draw and stays in the pool', () => {
  const p = new UniformCardDrawPolicy(new Prng(3), [def('infantry_1')]);
  p.unlock(def('archer_1'));
  assert.equal(p.draw().id, 'archer_1');
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(p.draw().id);
  assert.deepEqual([...seen].sort(), ['archer_1', 'infantry_1']);
});

test('TutorialDrawPolicy.unlock: the script still comes first, then the unlocked card', () => {
  const p = new TutorialDrawPolicy([def('infantry_1'), def('tower_1')], [], new Prng(1));
  p.unlock(def('archer_1'));
  assert.deepEqual([p.draw().id, p.draw().id, p.draw().id], ['infantry_1', 'tower_1', 'archer_1']);
});

function unlockConfig(): GameConfig {
  const level: LevelDefinition = {
    id: 'test_card_unlocks',
    chapter: 0,
    seed: 5,
    objective: { kind: 'survive' },
    waves: { entries: [{ atTick: 9999, unitType: UnitType.Infantry, col: 0, count: 1 }] },
    loadout: ['infantry_1'],
    cardUnlocks: [{ atTick: 10, cardId: 'archer_1' }],
  };
  return { seed: 5, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level };
}

test('step(): a cardUnlock reaches the hand on the first redraw after its tick, never before', () => {
  const engine = createGameEngine(unlockConfig());
  const hand = () => engine.state.bottomPlayer.hand.slots.map((s) => s?.card.id);
  let firstSeen = -1;
  for (let tick = 0; tick < 2000 && firstSeen < 0; tick++) {
    engine.step(tick, []);
    if (hand().includes('archer_1')) firstSeen = tick;
  }
  assert.ok(firstSeen >= 10, `archer must not appear before its unlock tick (got ${firstSeen})`);
});

test('step(): cardUnlocks are deterministic across two runs', () => {
  const run = () => {
    const engine = createGameEngine(unlockConfig());
    const log: string[] = [];
    for (let tick = 0; tick < 1500; tick++) {
      engine.step(tick, []);
      log.push(engine.state.bottomPlayer.hand.slots.map((s) => s?.card.id ?? '-').join(','));
    }
    return log.join('|');
  };
  assert.equal(run(), run());
});

test('parseLevelDefinition: cardUnlocks / assistOnLoss validate', () => {
  const base = { id: 'x', chapter: 1, seed: 1, objective: { kind: 'survive' }, waves: { entries: [{ atTick: 1, unitType: 'max', col: 0, count: 1 }] } };
  const ok = parseLevelDefinition({ ...base, loadout: ['infantry_1'], cardUnlocks: [{ atTick: 30, cardId: 'archer_1' }], assistOnLoss: true });
  assert.deepEqual(ok.cardUnlocks, [{ atTick: 30, cardId: 'archer_1' }]);
  assert.equal(ok.assistOnLoss, true);
  assert.throws(() => parseLevelDefinition({ ...base, cardUnlocks: [{ atTick: 30, cardId: 'nope' }] }), LevelParseError);
  assert.throws(() => parseLevelDefinition({ ...base, loadout: ['archer_1'], cardUnlocks: [{ atTick: 30, cardId: 'archer_1' }] }), LevelParseError);
  assert.throws(() => parseLevelDefinition({ ...base, assistOnLoss: 'yes' }), LevelParseError);
});

test('applyAssist: scales enemies down and adds starting ink; refuses levels that did not opt in', () => {
  const level: LevelDefinition = {
    id: 'a', chapter: 1, seed: 1, objective: { kind: 'survive' }, waves: { entries: [] },
    enemyScale: { hp: 0.8, damage: 0.6 }, startInk: 40, assistOnLoss: true,
  };
  const a = applyAssist(level);
  assert.equal(a.enemyScale!.hp, 0.8 * ASSIST_ENEMY_SCALE);
  assert.equal(a.enemyScale!.damage, 0.6 * ASSIST_ENEMY_SCALE);
  assert.equal(a.startInk, 40 + ASSIST_BONUS_INK);
  assert.equal(level.startInk, 40, 'input untouched');
  assert.throws(() => applyAssist({ ...level, assistOnLoss: undefined }));
});

test('content revision: pre-revision builds count as rev 1 and only lack the reworked levels', () => {
  assert.ok(CAMPAIGN_CONTENT_REV >= levelContentRev('ch1_lv1'));
  assert.equal(levelContentRev('ch2_lv1'), 1);
  assert.equal(hasLevelContent(undefined, 'ch2_lv1'), true);
  assert.equal(hasLevelContent(0, 'ch1_lv1'), false);
  assert.equal(hasLevelContent(CAMPAIGN_CONTENT_REV, 'ch1_lv1'), true);
});
