/**
 * GameEngine orchestration smoke tests (createGameEngine / step / tick).
 *
 * The prior tests in this directory exercise isolated pieces (blueprints, armor math,
 * movement) but nothing drove the actual engine loop end-to-end. Added alongside the
 * GameEngine.ts → engine/*.ts mixin split (base/helpers/campaign/commands/winCondition/loop)
 * so a wrong mixin application order or a dropped `this` binding fails loudly here instead
 * of only showing up as a subtle runtime desync.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createGameEngine } from '../GameEngine';
import { runHeadless } from '../runHeadless';
import { LocalInputSource } from '../net/InputSource';
import { toFp } from '../math/fixed';
import { ATTACK_LANES, HAND_SIZE } from '../config';
import { CardType, GamePhase, Side } from '../types';
import type { GameConfig, PlayerCommand } from '../types';
import type { LevelDefinition } from '../campaign/LevelDefinition';

function pvpConfig(seed: number): GameConfig {
  return { seed, players: [{ id: 0 }, { id: 1 }] };
}

// ── Loop + initial events (LoopMixin.step / emitInitialEvents) ─────────────────────────

test('GameEngine.step(0, []) deals both hands and emits resource_changed once per side', () => {
  const engine = createGameEngine(pvpConfig(1));
  const events = engine.step(0, []);

  const drawn = events.filter((e) => e.type === 'card_drawn');
  const resourceChanged = events.filter((e) => e.type === 'resource_changed');
  assert.equal(drawn.length, HAND_SIZE * 2, 'both players draw a full hand on tick 0');
  assert.equal(resourceChanged.length, 2, 'one resource_changed per side after the deal');
  assert.equal(engine.state.phase, GamePhase.Playing);
});

test('GameEngine.step is idempotent-safe after GameOver: returns [] instead of re-emitting', () => {
  const engine = createGameEngine(pvpConfig(1));
  engine.step(0, []);
  engine.state.phase = GamePhase.GameOver;
  const events = engine.step(1, []);
  assert.deepEqual(events, []);
});

// ── Commands (CommandsMixin.processCommand / consumeCardSlot) ──────────────────────────

test('play_card command spends ink, spawns a unit, and draws a replacement card', () => {
  const engine = createGameEngine(pvpConfig(2));
  engine.step(0, []);

  const slots = engine.state.bottomPlayer.hand.slots;
  const unitSlotIndex = slots.findIndex((s) => s?.card.cardType === CardType.Unit);
  assert.ok(unitSlotIndex >= 0, 'seed 2 opening hand has at least one unit card');
  const card = slots[unitSlotIndex]!.card;

  // Grant enough ink directly (setup only) so the play isn't skipped by the affordability guard.
  engine.state.bottomPlayer.addInkFp(toFp(9999));
  const inkBefore = engine.state.bottomPlayer.ink;

  const cmd: PlayerCommand = { type: 'play_card', owner: 0, tick: 1, handIndex: unitSlotIndex, col: ATTACK_LANES[0] };
  const events = engine.step(1, [cmd]);

  assert.ok(events.some((e) => e.type === 'card_played'), 'card_played fires');
  assert.ok(events.some((e) => e.type === 'unit_spawned' && e.owner === 0), 'unit_spawned fires for owner 0');
  assert.ok(events.some((e) => e.type === 'card_drawn' && e.handIndex === unitSlotIndex), 'replacement card drawn into the same slot');
  assert.equal(engine.state.bottomPlayer.ink, inkBefore - card.cost);
});

test('play_card is rejected when the player cannot afford the card (no ink spent, no spawn)', () => {
  const engine = createGameEngine(pvpConfig(2));
  engine.step(0, []);

  const slots = engine.state.bottomPlayer.hand.slots;
  const unitSlotIndex = slots.findIndex((s) => s?.card.cardType === CardType.Unit);
  const inkBefore = engine.state.bottomPlayer.ink; // starting ink, not topped up

  const cmd: PlayerCommand = { type: 'play_card', owner: 0, tick: 1, handIndex: unitSlotIndex, col: ATTACK_LANES[0] };
  const events = engine.step(1, [cmd]);

  assert.ok(!events.some((e) => e.type === 'unit_spawned'), 'no spawn without enough ink');
  assert.equal(engine.state.bottomPlayer.ink, inkBefore, 'ink untouched on a rejected play');
});

// ── Render-facing API + LocalInputSource plumbing (playCard → tick) ────────────────────

test('engine.playCard() self-forwards through LocalInputSource and applies on the next tick()', () => {
  const engine = createGameEngine(pvpConfig(3));
  engine.tick(1 / 30); // drives step(0, []) — deals hands

  const slots = engine.state.bottomPlayer.hand.slots;
  const unitSlotIndex = slots.findIndex((s) => s?.card.cardType === CardType.Unit);
  assert.ok(unitSlotIndex >= 0);
  engine.state.bottomPlayer.addInkFp(toFp(9999));

  engine.playCard(unitSlotIndex, ATTACK_LANES[0]);
  engine.tick(1 / 30);

  const hasUnit = Array.from(engine.state.board.units.values()).some((u) => u.side === Side.Bottom);
  assert.ok(hasUnit, 'the unit placed via playCard() actually landed on the board');
});

// ── Win condition (WinConditionMixin + CampaignMixin, via runHeadless) ─────────────────

test('campaign timed_defense objective ends the match with GamePhase.GameOver and Bottom winning', () => {
  const level: LevelDefinition = {
    id: 'test_timed_defense',
    chapter: 0,
    seed: 4,
    objective: { kind: 'timed_defense', durationTicks: 5 },
    waves: { entries: [] },
  };
  const config: GameConfig = { seed: 4, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level };
  const outcome = runHeadless(config, new LocalInputSource(), 30);

  assert.ok(outcome.ok, 'match reaches GameOver within maxTicks');
  assert.equal(outcome.engine.state.phase, GamePhase.GameOver);
  assert.equal(outcome.engine.state.winner, Side.Bottom);
});
