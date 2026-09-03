/**
 * The engine's remaining scattered branch gaps — one or two per file, each in a different
 * module, none of them big enough to justify a file of its own:
 *
 *   · `balance/pveUpgrades.ts`  garrisonProgressionRatios' four early-outs
 *   · `balance/progression.ts`  applyUnitLevels with no level map at all
 *   · `math/fixed.ts`           divFp's zero/negative-divisor guard
 *   · `systems/ai/threatAssessment.ts`  out-of-bounds unit col, the rolling-window eviction,
 *                               and pickLane handed a malformed threat array
 *   · `systems/ai/cardSelection.ts`     the "cannot touch a flyer" hard counter
 *   · `systems/ai/meteorTargeting.ts`   an empty board, and two units sharing one cell
 *   · `systems/AISystem.ts`     a Building card in hand that is NOT a barracks
 *   · `systems/TraitSystem.ts`  a Top-side summoner (every existing case summons for Bottom)
 *   · `Card.ts`                 the tutorial policy's free-play stage + Hand's empty-slot paths
 *
 * What they have in common is that they are all "the other side of a guard that has only ever
 * been taken one way", and in every case the untaken side is the one that decides whether bad
 * input degrades gracefully or poisons the sim: `divFp`'s guard is what keeps a dirty blueprint
 * from producing Infinity/NaN inside a deterministic replay, the ratio guards keep a 0-attack
 * support unit from yielding NaN×, and the AI's lane pickers must answer `null` rather than
 * `undefined` for a caller that then indexes a board column with it.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Hand, TutorialDrawPolicy } from '../Card';
import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import {
  ATTACK_LANES,
  BOTTOM_BUILDING_ROW,
  BOARD_COLS,
  CARD_DEFINITIONS,
  HAND_SIZE,
  TOP_BUILDING_ROW,
  UNIT_BLUEPRINTS,
} from '../config';
import { createGameEngine } from '../GameEngine';
import { buildEngineCtx } from '../engine/setup/buildCtx';
import type { LevelDefinition } from '../campaign/LevelDefinition';
import { applyUnitLevels } from '../balance/progression';
import type { EngineCardInstance } from '../balance/equipment';
import { buildPvpBlueprints, garrisonProgressionRatios } from '../balance/pveUpgrades';
import { divFp, toFp, TICK_RATE, type Fp } from '../math/fixed';
import { Prng } from '../math/prng';
import { AISystem, DIFFICULTY } from '../systems/AISystem';
import { TraitSystem } from '../systems/TraitSystem';
import { counterScore } from '../systems/ai/cardSelection';
import { findMeteorTarget } from '../systems/ai/meteorTargeting';
import {
  computeThreatByCol,
  pickLane,
  recordThreatHistory,
} from '../systems/ai/threatAssessment';
import { THREAT_HISTORY_LEN, type AiCtx } from '../systems/ai/types';
import {
  BuildingType,
  CardType,
  Side,
  UnitType,
  type AIDifficulty,
  type PlayerCommand,
  type UnitBlueprint,
} from '../types';

/** Mid-ladder difficulty: threat memory / counter-picking on, but not the top-tier behaviour. */
const L5 = 5 as AIDifficulty;

// ── balance/pveUpgrades.ts: garrisonProgressionRatios ───────────────────────────────────────

function defenderCard(unitType: UnitType, level: number, id = `c_${unitType}`): EngineCardInstance {
  return { id, defId: unitType, unitType, level, gear: {} };
}

test('garrisonProgressionRatios on an empty roster returns empty tables without building any blueprint', () => {
  // A city held by a sect with no garrison team parked in it. The early-out matters because the
  // caller folds these into a fortification multiplier — an absent key must mean "no buff",
  // which is what an empty table gives it.
  const ratios = garrisonProgressionRatios([]);
  assert.deepEqual(ratios, { hp: {}, attack: {} });
});

test('garrisonProgressionRatios reports one entry per unit type, ignoring duplicate cards', () => {
  // Two Infantry cards: the table is already best-per-type (buildSiegeBlueprints picks the
  // highest level), so the second card must not overwrite the first entry with a weaker ratio.
  const ratios = garrisonProgressionRatios([
    defenderCard(UnitType.Infantry, 9, 'a'),
    defenderCard(UnitType.Infantry, 1, 'b'),
  ]);
  assert.deepEqual(Object.keys(ratios.hp), [UnitType.Infantry]);
  assert.ok(ratios.hp[UnitType.Infantry]! > 1, 'the L9 card is the one that counted');

  const single = garrisonProgressionRatios([defenderCard(UnitType.Infantry, 9, 'a')]);
  assert.equal(ratios.hp[UnitType.Infantry], single.hp[UnitType.Infantry]);
  assert.equal(ratios.attack[UnitType.Infantry], single.attack[UnitType.Infantry]);
});

test('garrisonProgressionRatios skips a card whose unit type the blueprint table does not know', () => {
  // A save written by a newer client (or hand-edited): the type is not in the table, so there is
  // no baseline to divide by. Skipping it keeps the other cards' ratios intact instead of
  // emitting a NaN entry that would flow into the defender's fortification multiplier.
  const ratios = garrisonProgressionRatios([
    { id: 'x', defId: 'future', unitType: 'unit_from_a_future_release' as UnitType, level: 9, gear: {} },
    defenderCard(UnitType.Infantry, 9),
  ]);
  assert.deepEqual(Object.keys(ratios.hp), [UnitType.Infantry]);
  assert.equal(Object.values(ratios.hp).some(Number.isNaN), false);
});

test('garrisonProgressionRatios reports 1x for a unit whose baseline attack is 0 (support units)', () => {
  // The Medic has attack 0 by design. `attack_fp / 0` is Infinity, and Infinity flowing into the
  // fortification multiplier would make a single parked Medic worth an infinite base-HP buff.
  assert.equal(UNIT_BLUEPRINTS[UnitType.Medic].attack_fp, toFp(0), 'test premise: Medic cannot attack');
  const ratios = garrisonProgressionRatios([defenderCard(UnitType.Medic, 9)]);
  assert.equal(ratios.attack[UnitType.Medic], 1, 'no attack to scale = neutral 1x, not Infinity');
  assert.ok(Number.isFinite(ratios.hp[UnitType.Medic]!));
  // (The mirrored `baseHp > 0` guard has no reachable input: every blueprint in the table has
  // positive hp, so only the guard's true arm can run today. It stays as the symmetric partner
  // of this one rather than being deleted.)
});

// ── balance/progression.ts ──────────────────────────────────────────────────────────────────

test('applyUnitLevels with no level map at all is a no-op', () => {
  // buildCampaignBlueprints always passes a (possibly empty) object, but the parameter is
  // optional and the PvE path is the one place a missing SaveData field could arrive as
  // undefined — it must mean "everyone is L1", not "crash while baking blueprints".
  const bp = buildPvpBlueprints();
  const before = JSON.stringify(bp);
  applyUnitLevels(bp, undefined);
  assert.equal(JSON.stringify(bp), before);
});

// ── math/fixed.ts ───────────────────────────────────────────────────────────────────────────

test('divFp returns 0 for a zero or negative divisor instead of Infinity / a negative quotient', () => {
  assert.equal(divFp(toFp(10), toFp(2)), toFp(5));
  // The guard's whole purpose: a dirty blueprint (0-attack, 0-interval, …) must not be able to
  // put Infinity or NaN into a value the deterministic sim then compares across two clients.
  assert.equal(divFp(toFp(10), toFp(0)), 0);
  assert.equal(divFp(toFp(10), toFp(-2)), 0);
  assert.equal(divFp(toFp(0), toFp(0)), 0);
});

// ── systems/ai/threatAssessment.ts ──────────────────────────────────────────────────────────

test('computeThreatByCol ignores a unit sitting outside the board columns', () => {
  // Nothing in the engine should produce one, which is exactly why the guard is worth a case:
  // without it `threat[-1] += …` silently adds a `-1` property to the array, and every later
  // `threat[lane]` read stays correct while the array is quietly no longer a dense number[].
  resetUnitIds();
  const state = new GameState(1);
  const inside = new Unit(UnitType.Infantry, Side.Bottom, 3, 5);
  const below = new Unit(UnitType.Infantry, Side.Bottom, 3, 5);
  const above = new Unit(UnitType.Infantry, Side.Bottom, 3, 5);
  below.col = -1;
  above.col = BOARD_COLS;
  for (const u of [inside, below, above]) state.board.addUnit(u);

  const threat = computeThreatByCol(state);
  assert.equal(threat.length, BOARD_COLS, 'still a dense array of exactly BOARD_COLS entries');
  assert.equal(threat[3], 6, 'row 5 → weight 6, and only the in-bounds unit contributed');
  assert.equal(threat.reduce((a, b) => a + b, 0), 6);
});

test('recordThreatHistory evicts the oldest snapshot once the window is full', () => {
  const history: number[][] = [];
  for (let i = 0; i < THREAT_HISTORY_LEN; i++) recordThreatHistory(history, [i]);
  assert.equal(history.length, THREAT_HISTORY_LEN);
  assert.deepEqual(history[0], [0]);

  recordThreatHistory(history, [999]);
  assert.equal(history.length, THREAT_HISTORY_LEN, 'the window never grows past its bound');
  assert.deepEqual(history[0], [1], 'the oldest snapshot is the one that left');
  assert.deepEqual(history[history.length - 1], [999]);
});

test('pickLane answers null rather than undefined when the threat array has no lane data', () => {
  // `mostRisingLane`/`pickLane` results are fed straight into a `col:` field on a command, so
  // the difference between `null` (caller skips the play) and `undefined` (caller plays into
  // column `undefined`) is the difference between no action and a corrupt command.
  const ctx: AiCtx = { params: DIFFICULTY[L5]!, rng: new Prng(1), threatHistory: [] };
  assert.equal(pickLane(ctx, [], /*mostThreatened*/ true), null);
  assert.equal(pickLane(ctx, [], /*mostThreatened*/ false), null);
  // ...and with real data it does pick, in both directions.
  const threat = new Array(BOARD_COLS).fill(5);
  threat[9] = 50;
  threat[8] = 0;
  assert.equal(pickLane(ctx, threat, true), 9);
  assert.equal(pickLane(ctx, threat, false), 8);
});

// ── systems/ai/cardSelection.ts ─────────────────────────────────────────────────────────────

test('counterScore penalises a candidate that cannot hit a flying enemy', () => {
  const harpy = UNIT_BLUEPRINTS[UnitType.Harpy];
  const infantry = UNIT_BLUEPRINTS[UnitType.Infantry];
  const archer = UNIT_BLUEPRINTS[UnitType.Archer];
  assert.equal(harpy.flying, true);

  const meleeVsHarpy = counterScore(infantry, [harpy]);
  const archerVsHarpy = counterScore(archer, [harpy]);
  // The penalty is a flat -50 per unhittable enemy, i.e. a HARD counter: it has to outweigh the
  // usual HP/DPS/range terms, or the AI keeps answering a harpy with melee it cannot reach.
  assert.ok(meleeVsHarpy < archerVsHarpy - 40, `melee ${meleeVsHarpy} vs archer ${archerVsHarpy}`);

  // Against a GROUND enemy the same melee unit is not penalised — the branch is about
  // targetability, not about the archer being better in general.
  const groundEnemy = UNIT_BLUEPRINTS[UnitType.Runner];
  assert.ok(counterScore(infantry, [groundEnemy]) > meleeVsHarpy);
});

// ── systems/ai/meteorTargeting.ts ───────────────────────────────────────────────────────────

test('findMeteorTarget returns null when no enemy unit is on the board at all', () => {
  const state = new GameState(1);
  assert.equal(findMeteorTarget(state, 1, false, 0), null);
  // Only Bottom units count: a board holding just the AI's own units is still "no cluster".
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Top, 3, 5));
  assert.equal(findMeteorTarget(state, 1, false, 0), null);
});

test('findMeteorTarget counts two units sharing one cell as two', () => {
  // Cells legitimately hold >1 unit (continuous fp positions snapped to an integer cell), and
  // the per-cell unit LIST is what the value-trade gate sums ink costs over — appending to an
  // existing list vs. starting a new one is the difference between a stacked pair reading as
  // 2 units' worth of ink and reading as 1.
  resetUnitIds();
  const state = new GameState(1);
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 3, 5));
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 3, 5));

  assert.notEqual(findMeteorTarget(state, 2, false, 0), null, 'a stacked pair is a 2-unit cluster');
  assert.equal(findMeteorTarget(state, 3, false, 0), null, '...but not a 3-unit one');
});

// ── systems/AISystem.ts ─────────────────────────────────────────────────────────────────────

test('the barracks-seeding step ignores a Building card that is not a barracks', () => {
  // The predicate is `cardType === Building && buildingType === Barracks`. With only an arrow
  // tower in hand the right-hand side must fail, so step 3 finds no barracks card and falls
  // through — an inverted predicate would seed towers where barracks belong (and then never
  // stop, since countOwnBarracks would never rise).
  const towerCard = CARD_DEFINITIONS.find(
    (c) => c.cardType === CardType.Building && c.buildingType === BuildingType.ArrowTower,
  )!;
  const state = new GameState(7);
  state.topPlayer.hand.drawIntoSlot(0, towerCard, 999);
  state.topPlayer.addInkFp(999 * 1000);
  // One enemy far from the AI base (row 1 << dangerRow 12): enough threat that step 2's
  // "reachable and safe" upgrade planning is skipped, so the decision actually falls through
  // to step 3 — without it the AI just banks/upgrades and the barracks step never runs.
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 2, 1));

  const ai = new AISystem(new Prng(3), L5);
  let cmds: readonly PlayerCommand[] = [];
  for (let tick = 0; tick < DIFFICULTY[L5]!.thinkIntervalTicks; tick++) {
    cmds = ai.decideTick(tick, state);
  }
  const played = cmds.filter((c): c is Extract<PlayerCommand, { type: 'play_card' }> => c.type === 'play_card');
  for (const cmd of played) {
    const card = state.topPlayer.hand.cards[cmd.handIndex];
    assert.notEqual(
      card?.buildingType,
      BuildingType.Barracks,
      'an arrow tower must never be played as if it were the barracks the step asked for',
    );
  }
});

test('the AI banks ink instead of spending when it is close to affording the next base upgrade', () => {
  // Step 2's second half: reachable upgrade, board quiet, cannot afford it yet, but past the 60%
  // mark — so the correct answer is to do NOTHING this tick. An empty command list here and a
  // "no upgrade possible" fallthrough look identical from the outside, which is why it needs a
  // case: if this arm inverted, the AI would spend its savings on units and never upgrade.
  const state = new GameState(9);
  const cost = state.topPlayer.nextUpgradeCost!;
  state.topPlayer.addInkFp(Math.floor(cost * 0.6) * 1000);
  assert.equal(state.topPlayer.canUpgradeBase(), false, 'test premise: not affordable yet');
  state.topPlayer.hand.drawIntoSlot(0, CARD_DEFINITIONS[0]!, 999);

  const ai = new AISystem(new Prng(3), L5);
  let cmds: readonly PlayerCommand[] = [];
  for (let tick = 0; tick < DIFFICULTY[L5]!.thinkIntervalTicks; tick++) {
    cmds = ai.decideTick(tick, state);
  }
  assert.deepEqual(cmds, [], 'saving up beats spending the savings');

  // One ink less and it is below the 60% line, so it stops saving and acts instead.
  const spending = new GameState(9);
  spending.topPlayer.addInkFp((Math.floor(cost * 0.6) - 1) * 1000);
  spending.topPlayer.hand.drawIntoSlot(0, CARD_DEFINITIONS[0]!, 999);
  const ai2 = new AISystem(new Prng(3), L5);
  let cmds2: readonly PlayerCommand[] = [];
  for (let tick = 0; tick < DIFFICULTY[L5]!.thinkIntervalTicks; tick++) {
    cmds2 = ai2.decideTick(tick, spending);
  }
  assert.notDeepEqual(cmds2, [], 'below the line it no longer holds');
});


// ── engine/setup/blueprints.ts + engine/sim/commands.ts ─────────────────────────────────────

test('a campaign level with enemyScale scales the enemy wave table and floors at 1 point', () => {
  // The PvE difficulty knob (`level.enemyScale`) is the one input that makes the enemy wave
  // table differ from the plain baseline. Without a level that sets it, the guard only ever
  // takes its "no scaling" arm, so the arithmetic below — including the "at least 1" floor that
  // keeps a tiny multiplier from producing a 0-attack enemy that can never win — never runs.
  const level: LevelDefinition = {
    id: 'lv_scale',
    chapter: 1,
    seed: 5,
    objective: { kind: 'survive' },
    waves: { entries: [] },
    enemyScale: { hp: 2, damage: 3 },
  };
  const ctx = buildEngineCtx({ seed: 5, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level });
  const plain = buildPvpBlueprints();
  const scaled = ctx.enemyWaveBlueprints;
  assert.equal(scaled[UnitType.Infantry].hp_fp, plain[UnitType.Infantry].hp_fp * 2);
  assert.equal(scaled[UnitType.Infantry].attack_fp, plain[UnitType.Infantry].attack_fp * 3);
  // The PLAYER's own table must not move — enemyScale is enemy-side only.
  assert.equal(ctx.state.unitBlueprints[UnitType.Infantry].hp_fp, plain[UnitType.Infantry].hp_fp);

  // A near-zero multiplier still leaves a unit that can act (floor of 1 real point).
  const tiny: LevelDefinition = { ...level, enemyScale: { hp: 0.0001, damage: 0.0001 } };
  const tinyCtx = buildEngineCtx({ seed: 5, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level: tiny });
  assert.equal(tinyCtx.enemyWaveBlueprints[UnitType.Infantry].hp_fp, toFp(1));
  assert.equal(tinyCtx.enemyWaveBlueprints[UnitType.Infantry].attack_fp, toFp(1));

  // ...and only one of the two multipliers being set leaves the other at 1x.
  const hpOnly: LevelDefinition = { ...level, enemyScale: { hp: 2 } };
  const hpOnlyCtx = buildEngineCtx({ seed: 5, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level: hpOnly });
  assert.equal(
    hpOnlyCtx.enemyWaveBlueprints[UnitType.Infantry].attack_fp,
    plain[UnitType.Infantry].attack_fp,
  );
});

test('a building card is refused on an occupied slot and on a no-build cell, and keeps its ink', () => {
  const towerCard = CARD_DEFINITIONS.find(
    (c) => c.cardType === CardType.Building && c.buildingType === BuildingType.ArrowTower,
  )!;
  const engine = createGameEngine({ seed: 31, players: [{ id: 0 }, { id: 1 }] });
  engine.step(0, []);
  const player = engine.state.bottomPlayer;
  player.addInkFp(toFp(9999));
  const lane = ATTACK_LANES[0]!;

  // ① First placement succeeds. `col` is mandatory for a building card (a command without one
  // is refused outright), so it is passed explicitly here and in every step below.
  player.hand.drawIntoSlot(0, towerCard, 900);
  engine.step(1, [{ type: 'play_card', owner: 0, tick: 1, handIndex: 0, col: lane }]);
  assert.notEqual(engine.state.board.getBuildingAt(lane, BOTTOM_BUILDING_ROW), null);

  // ② A second card aimed at the lane the first one took is refused — and, crucially, the card
  // stays in hand and the ink is not spent, rather than being consumed for nothing.
  player.hand.drawIntoSlot(1, towerCard, 900);
  const inkAfterFirst = player.ink;
  engine.step(2, [{ type: 'play_card', owner: 0, tick: 2, handIndex: 1, col: lane }]);
  assert.equal(player.ink, inkAfterFirst, 'a refused placement costs nothing');
  assert.notEqual(player.hand.cards[1], null, 'and the card is still in hand');

  // ...as is a command with no target column at all.
  engine.step(3, [{ type: 'play_card', owner: 0, tick: 3, handIndex: 1 }]);
  assert.equal(player.ink, inkAfterFirst);

  // ③ A no-build cell refuses the same way.
  const freeLane = ATTACK_LANES[1]!;
  engine.state.board.setNoBuild([{ col: freeLane, row: BOTTOM_BUILDING_ROW }]);
  player.hand.drawIntoSlot(2, towerCard, 900);
  const inkBefore = player.ink;
  engine.step(4, [{ type: 'play_card', owner: 0, tick: 4, handIndex: 2, col: freeLane }]);
  assert.equal(engine.state.board.getBuildingAt(freeLane, BOTTOM_BUILDING_ROW), null);
  assert.equal(player.ink, inkBefore);
});

test('a Top-side building card lands on the TOP building row', () => {
  // Every existing building-card case is played by the Bottom player, so the row selector had
  // only ever taken one arm. A Top building on row 0 would sit inside the enemy base.
  const towerCard = CARD_DEFINITIONS.find(
    (c) => c.cardType === CardType.Building && c.buildingType === BuildingType.ArrowTower,
  )!;
  const engine = createGameEngine({ seed: 32, players: [{ id: 0 }, { id: 1 }] });
  engine.step(0, []);
  const top = engine.state.topPlayer;
  top.addInkFp(toFp(9999));
  top.hand.drawIntoSlot(0, towerCard, 900);
  const lane = ATTACK_LANES[3]!;

  engine.step(1, [{ type: 'play_card', owner: 1, tick: 1, handIndex: 0, col: lane }]);
  assert.notEqual(engine.state.board.getBuildingAt(lane, TOP_BUILDING_ROW), null);
  assert.equal(engine.state.board.getBuildingAt(lane, BOTTOM_BUILDING_ROW), null);
});

// ── systems/TraitSystem.ts ──────────────────────────────────────────────────────────────────

test('a Top-side summoner sends its summon toward the BOTTOM building row', () => {
  // Every existing summonOnTimer case summons for Bottom, so the destination row was only ever
  // TOP_BUILDING_ROW. A Top summon walking to row 17 would march into its OWN base.
  resetUnitIds();
  const state = new GameState(1);
  const traitSystem = new TraitSystem();
  const bp: UnitBlueprint = {
    ...UNIT_BLUEPRINTS[UnitType.Infantry],
    summonOnTimer: { type: UnitType.Runner, intervalSec: 1 / TICK_RATE },
  };
  const summoner = new Unit(UnitType.Infantry, Side.Top, 4, 12, bp);
  state.board.addUnit(summoner);
  assert.equal(summoner.summonCooldownTicks, 1);

  traitSystem.tick(state);
  const moveStart = state.events.find((e) => e.type === 'unit_move_start');
  assert.ok(moveStart, 'the summon must announce where it is heading');
  assert.equal(
    (moveStart as Extract<typeof moveStart, { type: 'unit_move_start' }>).to.y_fp,
    toFp(BOTTOM_BUILDING_ROW),
    'a Top summon heads for row 0, not its own base at row 17',
  );
  assert.notEqual(toFp(BOTTOM_BUILDING_ROW), toFp(TOP_BUILDING_ROW) as Fp);
});

// ── Card.ts: TutorialDrawPolicy free play + Hand's empty slots ──────────────────────────────

test('TutorialDrawPolicy deals the script in order, then filler, then the full pool in free play', () => {
  const [a, b, c, d] = CARD_DEFINITIONS;
  const script = [a!, b!];
  const filler = [c!];
  const policy = new TutorialDrawPolicy(script, filler, new Prng(5));

  assert.equal(policy.draw(), a, 'beat order is deterministic — the director looks for these');
  assert.equal(policy.draw(), b);
  assert.equal(policy.draw(), c, 'past the script: filler only, so a teaching card is never wasted');

  // Stage C re-includes the teaching cards, so every draw now comes from script + filler.
  policy.enterFreePlay();
  const pool = new Set([a, b, c]);
  for (let i = 0; i < 20; i++) assert.ok(pool.has(policy.draw()), 'free play draws from the full loadout');
  assert.equal(pool.has(d!), false, 'test premise: d is outside this policy\'s loadout');
});

test('TutorialDrawPolicy with an empty loadout falls back to the whole card pool in free play', () => {
  // A degenerate configuration (no script, no filler) must still hand out a real card rather
  // than `undefined`, which the caller would put straight into a hand slot.
  const policy = new TutorialDrawPolicy([], [], new Prng(5));
  policy.enterFreePlay();
  const drawn = policy.draw();
  assert.ok(CARD_DEFINITIONS.includes(drawn));
});

test('Hand.play on an empty slot and on an out-of-range index both answer null', () => {
  const hand = new Hand();
  assert.equal(hand.play(0), null, 'an empty slot has no card');
  assert.equal(hand.play(HAND_SIZE + 5), null, 'an out-of-range index is undefined, not a crash');

  const card = CARD_DEFINITIONS[0]!;
  hand.drawIntoSlot(1, card, 30);
  assert.equal(hand.play(1), card);
  assert.equal(hand.slots[1], null, 'playing clears the slot');
  assert.equal(hand.play(1), null, '...so playing the same slot twice does not duplicate the card');
});

test('Hand.tickTimers skips empty slots and reports only the ones that expired', () => {
  const hand = new Hand();
  hand.drawIntoSlot(0, CARD_DEFINITIONS[0]!, 1);
  hand.drawIntoSlot(2, CARD_DEFINITIONS[1]!, 5);
  // Slots 1 and 3+ are empty — the skip arm. Without it this throws on `slot.refreshRemainingTicks`.
  assert.deepEqual(hand.tickTimers(), [0], 'only the 1-tick timer reached 0');
  assert.equal(hand.slots[2]!.refreshRemainingTicks, 4);

  // An expired slot is NOT cleared here — it keeps reporting until the caller refills it, which
  // is what makes the refresh idempotent if a tick is dropped.
  assert.deepEqual(hand.tickTimers(), [0], 'still expired, still reported');
  hand.drawIntoSlot(0, CARD_DEFINITIONS[2]!, 5);
  assert.deepEqual(hand.tickTimers(), [], 'refilled: nothing is expired any more');

  const empty = new Hand();
  assert.deepEqual(empty.tickTimers(), [], 'an all-empty hand walks every slot and reports nothing');
});
