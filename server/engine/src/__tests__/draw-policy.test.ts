/**
 * Direct unit coverage for engine/setup/drawPolicy.ts's applyPveDrawPolicy /
 * applyPvpDeckPolicy — resolving each side's card draw pool at match setup.
 *
 * goldenReplay scenarios exercise loadout/levelSpells/decks end-to-end through a full
 * engine run, but the tutorial scripted-draw branch (level.id === TUTORIAL_LEVEL_ID),
 * the various empty/fallback pool branches, and applyPvpDeckPolicy's no-op path had no
 * direct isolated coverage — this file closes those gaps.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { applyPveDrawPolicy, applyPvpDeckPolicy } from '../engine/setup/drawPolicy';
import { UniformCardDrawPolicy, TutorialDrawPolicy } from '../Card';
import { TUTORIAL_LEVEL_ID, TUTORIAL_TEACHING_CARDS } from '../campaign/tutorial';
import { CARD_DEFINITIONS } from '../config';
import type { LevelDefinition } from '../campaign/LevelDefinition';
import type { GameConfig } from '../types';

function baseLevel(overrides: Partial<LevelDefinition> = {}): LevelDefinition {
  return {
    id: 'test_level',
    chapter: 0,
    seed: 1,
    objective: { kind: 'survive' },
    waves: { entries: [] },
    ...overrides,
  };
}

// ─── applyPveDrawPolicy ──────────────────────────────────────────────────────

test('applyPveDrawPolicy: a level with no loadout/bannedCards/levelSpells is a complete no-op', () => {
  const state = new GameState(1);
  const original = state.bottomPlayer.drawPolicy;
  const result = applyPveDrawPolicy(state, baseLevel(), 1);
  assert.deepEqual(result, []);
  assert.equal(state.bottomPlayer.drawPolicy, original, 'drawPolicy must stay at the GameState-constructed default');
});

test('applyPveDrawPolicy: loadout restricts the draw pool to exactly the listed card ids', () => {
  const state = new GameState(2);
  const loadout = ['infantry_1', 'archer_1'];
  const result = applyPveDrawPolicy(state, baseLevel({ loadout }), 2);
  assert.deepEqual(result, []);
  assert.ok(state.bottomPlayer.drawPolicy instanceof UniformCardDrawPolicy);
  for (let i = 0; i < 50; i++) {
    const card = state.bottomPlayer.drawPolicy.draw();
    assert.ok(loadout.includes(card.id), `drew '${card.id}' outside the loadout`);
  }
});

test('applyPveDrawPolicy: bannedCards excludes the listed ids from the draw pool', () => {
  const state = new GameState(3);
  const banned = ['meteor_1', 'haste_1'];
  const result = applyPveDrawPolicy(state, baseLevel({ bannedCards: banned }), 3);
  assert.deepEqual(result, []);
  for (let i = 0; i < 50; i++) {
    const card = state.bottomPlayer.drawPolicy.draw();
    assert.ok(!banned.includes(card.id), `drew banned card '${card.id}'`);
  }
});

test('applyPveDrawPolicy: an unknown levelSpells cardId throws', () => {
  const state = new GameState(4);
  assert.throws(
    () => applyPveDrawPolicy(state, baseLevel({ levelSpells: [{ cardId: 'not_a_real_spell', initialCount: 1 }] }), 4),
    /levelSpells: unknown spell card/,
  );
});

test('applyPveDrawPolicy: levelSpells returns the initial spell cards to force-inject, matching initialCount', () => {
  const state = new GameState(5);
  const result = applyPveDrawPolicy(state, baseLevel({ levelSpells: [{ cardId: 'rockslide', initialCount: 2 }] }), 5);
  assert.equal(result.length, 2);
  assert.ok(result.every((c) => c.id === 'rockslide'));
});

test('applyPveDrawPolicy: tutorial level id assigns a TutorialDrawPolicy that deals teaching cards first, in order', () => {
  const state = new GameState(6);
  const loadout = [...TUTORIAL_TEACHING_CARDS, 'archer_1'];
  applyPveDrawPolicy(state, baseLevel({ id: TUTORIAL_LEVEL_ID, loadout }), 6);
  assert.ok(state.bottomPlayer.drawPolicy instanceof TutorialDrawPolicy);

  const drawn = [0, 1, 2].map(() => state.bottomPlayer.drawPolicy.draw().id);
  assert.deepEqual(drawn, [...TUTORIAL_TEACHING_CARDS]);

  // Once the script is exhausted, the filler pool (loadout minus teaching cards) takes over.
  const filler = state.bottomPlayer.drawPolicy.draw();
  assert.equal(filler.id, 'archer_1');
});

test('applyPveDrawPolicy: tutorial level whose loadout omits a teaching card silently skips it (no undefined pushed)', () => {
  const state = new GameState(7);
  // Only 'infantry_1' of the three teaching cards is in the loadout.
  applyPveDrawPolicy(state, baseLevel({ id: TUTORIAL_LEVEL_ID, loadout: ['infantry_1'] }), 7);
  const policy = state.bottomPlayer.drawPolicy;
  assert.ok(policy instanceof TutorialDrawPolicy);
  // Script holds only the one resolvable teaching card; filler is empty so it falls back to
  // re-drawing from the script itself (TutorialDrawPolicy.draw()'s own fallback).
  assert.equal(policy.draw().id, 'infantry_1');
  assert.equal(policy.draw().id, 'infantry_1');
});

test('applyPveDrawPolicy: banning every card id yields an empty custom pool, falling back to the full CARD_DEFINITIONS pool', () => {
  const state = new GameState(8);
  const allIds = CARD_DEFINITIONS.map((c) => c.id);
  applyPveDrawPolicy(state, baseLevel({ bannedCards: allIds }), 8);
  assert.ok(state.bottomPlayer.drawPolicy instanceof UniformCardDrawPolicy);
  const card = state.bottomPlayer.drawPolicy.draw();
  assert.ok(CARD_DEFINITIONS.some((c) => c.id === card.id));
});

// ─── applyPvpDeckPolicy ──────────────────────────────────────────────────────

test('applyPvpDeckPolicy: no decks in config is a no-op for both sides', () => {
  const state = new GameState(1);
  const bottomBefore = state.bottomPlayer.drawPolicy;
  const topBefore = state.topPlayer.drawPolicy;
  const config: GameConfig = { seed: 1, players: [{ id: 0 }, { id: 1 }] };
  applyPvpDeckPolicy(state, config);
  assert.equal(state.bottomPlayer.drawPolicy, bottomBefore);
  assert.equal(state.topPlayer.drawPolicy, topBefore);
});

test('applyPvpDeckPolicy: decks filter each side\'s draw pool independently', () => {
  const state = new GameState(2);
  const config: GameConfig = {
    seed: 2,
    players: [{ id: 0 }, { id: 1 }],
    decks: { bottom: ['infantry_1'], top: ['archer_1', 'archer_2'] },
  };
  applyPvpDeckPolicy(state, config);
  for (let i = 0; i < 20; i++) {
    assert.equal(state.bottomPlayer.drawPolicy.draw().id, 'infantry_1');
    assert.ok(['archer_1', 'archer_2'].includes(state.topPlayer.drawPolicy.draw().id));
  }
});

test('applyPvpDeckPolicy: a deck of entirely unknown card ids yields an empty pool, falling back to full CARD_DEFINITIONS', () => {
  const state = new GameState(3);
  const config: GameConfig = {
    seed: 3,
    players: [{ id: 0 }, { id: 1 }],
    decks: { bottom: ['not_a_real_card'], top: ['also_not_real'] },
  };
  applyPvpDeckPolicy(state, config);
  const bottomCard = state.bottomPlayer.drawPolicy.draw();
  const topCard = state.topPlayer.drawPolicy.draw();
  assert.ok(CARD_DEFINITIONS.some((c) => c.id === bottomCard.id));
  assert.ok(CARD_DEFINITIONS.some((c) => c.id === topCard.id));
});
