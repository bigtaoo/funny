/**
 * AI difficulty curve (L1-L10) coverage.
 *
 * The 12-axis DIFFICULTY table must move monotonically across levels and new
 * capabilities (counter-picking, haste/value-trades, threat memory) unlock at a
 * fixed level rather than as a single "hard mode" cliff — this file locks that
 * shape in so a future tuning pass can't silently invert it or drop the pacing
 * floor. It also covers the fair-play invariant (AI never reads the opponent's
 * hand) since that guarantee is load-bearing for replay review.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { AISystem, DIFFICULTY } from '../systems/AISystem';
import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { Prng } from '../math/prng';
import { AIDifficulty, CardType, Side, SpellType, UnitType } from '../types';
import { CARD_DEFINITIONS } from '../config';

const LEVELS: AIDifficulty[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// ─── DIFFICULTY table shape ─────────────────────────────────────────────────

test('DIFFICULTY has an entry for every level 1-10', () => {
  for (const lvl of LEVELS) {
    assert.ok(DIFFICULTY[lvl], `missing DIFFICULTY[${lvl}]`);
  }
});

test('thinkIntervalTicks strictly decreases with level and floors at 12 ticks (0.4s) at L10', () => {
  for (let i = 1; i < LEVELS.length; i++) {
    const prev = DIFFICULTY[LEVELS[i - 1]!]!.thinkIntervalTicks;
    const cur = DIFFICULTY[LEVELS[i]!]!.thinkIntervalTicks;
    assert.ok(cur < prev, `L${LEVELS[i]} thinkIntervalTicks (${cur}) not < L${LEVELS[i - 1]} (${prev})`);
  }
  assert.equal(DIFFICULTY[10]!.thinkIntervalTicks, 12);
  for (const lvl of LEVELS) {
    assert.ok(DIFFICULTY[lvl]!.thinkIntervalTicks >= 12, `L${lvl} thinkIntervalTicks below the 12-tick floor`);
  }
});

test('dangerRow is non-increasing and lowBaseHp is non-decreasing across levels', () => {
  for (let i = 1; i < LEVELS.length; i++) {
    const prevLvl = LEVELS[i - 1]!;
    const curLvl = LEVELS[i]!;
    assert.ok(
      DIFFICULTY[curLvl]!.dangerRow <= DIFFICULTY[prevLvl]!.dangerRow,
      `L${curLvl} dangerRow rose above L${prevLvl}`,
    );
    assert.ok(
      DIFFICULTY[curLvl]!.lowBaseHp >= DIFFICULTY[prevLvl]!.lowBaseHp,
      `L${curLvl} lowBaseHp dropped below L${prevLvl}`,
    );
  }
});

test('capability unlock boundaries: counter-picking at L6, haste/value-trades at L7, threat memory at L8', () => {
  for (const lvl of LEVELS) {
    assert.equal(DIFFICULTY[lvl]!.useCounterPicking, lvl >= 6, `useCounterPicking wrong at L${lvl}`);
    assert.equal(DIFFICULTY[lvl]!.useHaste, lvl >= 7, `useHaste wrong at L${lvl}`);
    assert.equal(DIFFICULTY[lvl]!.useValueTrades, lvl >= 7, `useValueTrades wrong at L${lvl}`);
    assert.equal(DIFFICULTY[lvl]!.useThreatMemory, lvl >= 8, `useThreatMemory wrong at L${lvl}`);
  }
});

test('L1 is the passive floor: no meteor/towers/barracks', () => {
  const l1 = DIFFICULTY[1]!;
  assert.equal(l1.useMeteor, false);
  assert.equal(l1.useTowers, false);
  assert.equal(l1.useBarracks, false);
});

test('L10 has every capability switched on', () => {
  const l10 = DIFFICULTY[10]!;
  assert.equal(l10.useMeteor, true);
  assert.equal(l10.useTowers, true);
  assert.equal(l10.useBarracks, true);
  assert.equal(l10.useHaste, true);
  assert.equal(l10.useCounterPicking, true);
  assert.equal(l10.useValueTrades, true);
  assert.equal(l10.useThreatMemory, true);
});

// ─── Constructor guard ───────────────────────────────────────────────────────

test('AISystem constructor rejects an out-of-range difficulty', () => {
  const rng = new Prng(1);
  assert.throws(() => new AISystem(rng, 0 as AIDifficulty), /invalid difficulty/);
  assert.throws(() => new AISystem(rng, 11 as AIDifficulty), /invalid difficulty/);
});

// ─── Fair-play invariant ─────────────────────────────────────────────────────

const meteorCardIndex = () => CARD_DEFINITIONS.findIndex(
  (c) => c.cardType === CardType.Spell && c.spellType === SpellType.Meteor,
);

/** Give the Top player the pool's Meteor card in hand slot 0 with plenty of ink. */
function giveMeteorCard(state: GameState): void {
  const idx = meteorCardIndex();
  const card = CARD_DEFINITIONS[idx]!;
  state.topPlayer.hand.drawIntoSlot(0, card, 999);
  state.topPlayer.addInkFp(999 * 1000);
}

/** Give the Bottom player (opponent) a full hand of every base unit card. */
function fillOpponentHand(state: GameState): void {
  const unitCards = CARD_DEFINITIONS.filter((c) => c.cardType === CardType.Unit);
  unitCards.forEach((card, i) => {
    if (i < 8) state.bottomPlayer.hand.drawIntoSlot(i, card, 999);
  });
}

test('AI decision is unaffected by the contents of the opponent hand (fair-play invariant)', () => {
  const stateA = new GameState(42);
  giveMeteorCard(stateA);
  // stateA's bottom hand stays empty.
  stateA.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 3, 15));
  stateA.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 3, 16));

  const stateB = new GameState(42);
  giveMeteorCard(stateB);
  fillOpponentHand(stateB); // only difference: bottom player's hand is fully stocked
  stateB.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 3, 15));
  stateB.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 3, 16));

  const aiA = new AISystem(new Prng(7), 10);
  const aiB = new AISystem(new Prng(7), 10);

  // decideTick only produces a decision once every thinkIntervalTicks calls (and []
  // on every other tick) — drive exactly that many ticks so the Nth call is the one
  // that fires, without a trailing empty call overwriting it.
  let cmdA: unknown[] = [];
  let cmdB: unknown[] = [];
  for (let tick = 0; tick < DIFFICULTY[10]!.thinkIntervalTicks; tick++) {
    cmdA = aiA.decideTick(tick, stateA);
    cmdB = aiB.decideTick(tick, stateB);
  }

  assert.deepEqual(cmdA, cmdB, 'AI decision changed when only the opponent hand differed');
  assert.ok(cmdA.length > 0, 'sanity: AI should have produced a decision this tick');
});

// ─── Black-box behaviour difference between L1 and L10 ──────────────────────

test('L1 never reaches for meteor even when a lethal cluster is in range; L10 does', () => {
  function buildPressuredState(): GameState {
    const state = new GameState(99);
    giveMeteorCard(state);
    // Dense cluster of 4 enemies near the AI base row (17) to trigger emergency defense.
    state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 4, 16));
    state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 5, 16));
    state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 4, 17));
    state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 5, 17));
    return state;
  }

  const isMeteorCommand = (cmds: unknown[]): boolean =>
    cmds.some((c: any) => c.type === 'play_card' && typeof c.row === 'number');

  const l1State = buildPressuredState();
  const l1 = new AISystem(new Prng(3), 1);
  let l1Fired = false;
  for (let tick = 0; tick < DIFFICULTY[1]!.thinkIntervalTicks + 1; tick++) {
    if (isMeteorCommand(l1.decideTick(tick, l1State))) l1Fired = true;
  }
  assert.equal(l1Fired, false, 'L1 should never cast Meteor (useMeteor is disabled at L1)');

  const l10State = buildPressuredState();
  const l10 = new AISystem(new Prng(3), 10);
  let l10Fired = false;
  for (let tick = 0; tick < DIFFICULTY[10]!.thinkIntervalTicks + 1; tick++) {
    if (isMeteorCommand(l10.decideTick(tick, l10State))) l10Fired = true;
  }
  assert.equal(l10Fired, true, 'L10 should cast Meteor on a 4-unit cluster pressing the base');
});
