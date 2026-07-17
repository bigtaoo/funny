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
import { ATTACK_LANES, BASE_HP, HAND_SIZE, TOP_SPAWN_ROW, UNIT_BLUEPRINTS } from '../config';
import { parseLevelDefinition, LevelParseError } from '../campaign/levelSchema';
import { CardType, GamePhase, Side, UnitType } from '../types';
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

// ── Defender base HP scaling (SLG option 2, 2026-07-17) ────────────────────────────────

test('siege defenderBaseHp initializes the Top base HP + maxBaseHp; default stays BASE_HP', () => {
  const level: LevelDefinition = {
    id: 'test_defender_base_hp',
    chapter: 0,
    seed: 9,
    objective: { kind: 'destroy_base' },
    waves: { entries: [] },
    defenderBaseHp: 40, // npcBaseHp(1) — a level-1 NPC tile
  };
  const config: GameConfig = { seed: 9, mode: 'siege', players: [{ id: 0 }, { id: 1 }], level };
  const engine = createGameEngine(config);
  engine.step(0, []);

  assert.equal(engine.state.topPlayer.maxBaseHp, 40, 'defender base ceiling scaled to defenderBaseHp');
  assert.equal(engine.state.topPlayer.baseHp, 40, 'defender base starts full at the scaled ceiling');
  // Attacker (Bottom) base is untouched → global BASE_HP default.
  assert.equal(engine.state.bottomPlayer.maxBaseHp, engine.state.bottomPlayer.baseHp, 'attacker base full at its default ceiling');
  assert.equal(engine.state.bottomPlayer.baseHp, BASE_HP, 'attacker base defaults to BASE_HP');
});

test('base_hp_changed carries the scaled defender maxBaseHp when an attacker reaches the base', () => {
  const col = ATTACK_LANES[0]!;
  const level: LevelDefinition = {
    id: 'test_defender_base_hp_event',
    chapter: 0,
    seed: 11,
    objective: { kind: 'destroy_base' },
    waves: { entries: [] },
    defenderBaseHp: 40, // npcBaseHp(1)
    // One attacker (Bottom) infantry pre-placed right at the top spawn row, next to the undefended Top base, so
    // it reaches and dents the base within a handful of ticks — keeps the test fast and deterministic.
    attackerArmy: [{ unitType: UnitType.Infantry, col, row: TOP_SPAWN_ROW, initialHp: 60 }],
  };
  const config: GameConfig = { seed: 11, mode: 'siege', players: [{ id: 0 }, { id: 1 }], level };
  const engine = createGameEngine(config);

  let hpEvent: { hp: number; maxHp: number; owner: number } | undefined;
  for (let tick = 0; tick < 2000 && !hpEvent; tick++) {
    for (const ev of engine.step(tick, [])) {
      if (ev.type === 'base_hp_changed') { hpEvent = { hp: ev.hp, maxHp: ev.maxHp, owner: ev.owner }; break; }
    }
  }

  assert.ok(hpEvent, 'the attacker reached the base and emitted base_hp_changed');
  assert.equal(hpEvent!.owner, 1, 'the damaged base is the defender (owner1/Top)');
  assert.equal(hpEvent!.maxHp, 40, 'maxHp reflects the scaled defenderBaseHp, not the flat BASE_HP=100');
  assert.equal(hpEvent!.hp, 40 - UNIT_BLUEPRINTS[UnitType.Infantry].siegeValue, 'first infantry hit deals its siege value off the scaled ceiling');
});

test('levelSchema validates defenderBaseHp: accepts a positive int, rejects <1 and >100000', () => {
  // battleTimeoutTicks marks this a siege battle → empty waves are allowed (isSiegeBattle in levelSchema).
  const base = { id: 'l', chapter: 0, seed: 1, objective: { kind: 'destroy_base' }, waves: { entries: [] }, battleTimeoutTicks: 100 };
  assert.equal(parseLevelDefinition({ ...base, defenderBaseHp: 400 }).defenderBaseHp, 400);
  assert.throws(() => parseLevelDefinition({ ...base, defenderBaseHp: 0 }), LevelParseError);
  assert.throws(() => parseLevelDefinition({ ...base, defenderBaseHp: -40 }), LevelParseError);
  assert.throws(() => parseLevelDefinition({ ...base, defenderBaseHp: 100_001 }), LevelParseError);
});

// ── Scripted enemy waves (CampaignMixin.spawnEnemyUnit + WaveDirector) ─────────────────

test('a scripted wave spawns via CampaignMixin and a leak past the base ends the match with Top winning', () => {
  const col = ATTACK_LANES[0];
  const level: LevelDefinition = {
    id: 'test_leak_limit',
    chapter: 0,
    seed: 5,
    objective: { kind: 'leak_limit', maxLeaks: 0 },
    waves: { entries: [{ atTick: 1, unitType: UnitType.Runner, col, count: 1 }] },
    // Shorten the lane to 1 row so the runner reaches row 0 almost immediately, instead of
    // needing to hand-simulate 250+ ticks of travel; it still has to walk laterally from
    // its lane into the base's column afterward before the leak actually registers.
    board: { laneLength: { [col]: 17 } },
  };
  const config: GameConfig = { seed: 5, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level };
  const outcome = runHeadless(config, new LocalInputSource(), 150);

  assert.ok(outcome.ok, 'match reaches GameOver within maxTicks');
  assert.equal(outcome.engine.state.phase, GamePhase.GameOver);
  assert.equal(outcome.engine.state.winner, Side.Top, 'a single leak past maxLeaks=0 loses the level');
  assert.equal(outcome.engine.state.enemyLeaks, 1);
});

// ── Match summary (GameState.snapshotSummary / game_stats event, STAR_SCORING.md) ──────

test('game_stats carries a MatchSummary alongside stats, matching state at game over', () => {
  const level: LevelDefinition = {
    id: 'test_summary_leak',
    chapter: 0,
    seed: 5,
    objective: { kind: 'leak_limit', maxLeaks: 0 },
    waves: { entries: [{ atTick: 1, unitType: UnitType.Runner, col: ATTACK_LANES[0], count: 1 }] },
    board: { laneLength: { [ATTACK_LANES[0]]: 17 } },
  };
  const config: GameConfig = { seed: 5, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level };
  const outcome = runHeadless(config, new LocalInputSource(), 150);
  assert.ok(outcome.ok);

  const statsEvent = outcome.engine.state.events.find((e) => e.type === 'game_stats');
  assert.ok(statsEvent && statsEvent.type === 'game_stats', 'the final tick emits a game_stats event');
  const { summary } = statsEvent;
  assert.equal(summary.elapsedTicks, outcome.engine.state.elapsedTicks, 'elapsedTicks matches state at game over');
  assert.equal(summary.enemyLeaks, 1, 'enemyLeaks reflects the leak that ended the match');
  assert.equal(summary.escortMinHpPct, null, 'no escorts on this level → null, not 0 or NaN');

  // snapshotSummary() is independently callable and must agree with the event payload.
  assert.deepEqual(outcome.engine.state.snapshotSummary(), summary);
});

test('snapshotSummary().escortMinHpPct is the lowest survival ratio across escorts (not the average)', () => {
  const level: LevelDefinition = {
    id: 'test_summary_escort',
    chapter: 0,
    seed: 6,
    objective: { kind: 'escort', required: 'all' },
    waves: { entries: [] },
    escorts: [
      { id: 'e1', hp: 100, speed: 0, startCol: ATTACK_LANES[0], startRow: 1 },
      { id: 'e2', hp: 100, speed: 0, startCol: ATTACK_LANES[1], startRow: 1 },
    ],
  };
  const config: GameConfig = { seed: 6, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level };
  const engine = createGameEngine(config);
  engine.step(0, []);

  // Damage one escort but not the other — min must reflect the weaker one, not an average.
  const [e1, e2] = engine.state.escorts;
  e1!.takeDamage(90); // 100 -> 10 (10%)
  e2!.takeDamage(20); // 100 -> 80 (80%)

  const summary = engine.state.snapshotSummary();
  assert.equal(summary.escortMinHpPct, 10, 'reports the lowest ratio (e1 at 10%), not e2\'s 80% or an average');
});
