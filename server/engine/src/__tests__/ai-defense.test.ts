/**
 * Direct unit coverage for systems/ai/defense.ts — tryDefend's arrow-tower branch (b)
 * and the tryHaste tempo helper, both previously exercised only indirectly (or not at
 * all) by ai_difficulty.test.ts's full-decision-pipeline scenarios. These call the
 * exported pure functions directly with a hand-built AiCtx/GameState so each branch can
 * be pinned down without fighting the rest of the decision pipeline (meteor priority,
 * upgrade planning, etc.).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { Building } from '../Building';
import { Prng } from '../math/prng';
import { toFp } from '../math/fixed';
import { BOARD_COLS, CARD_DEFINITIONS, TOP_BUILDING_ROW, ATTACK_LANES } from '../config';
import { BuildingType, CardType, Side, SpellType, UnitType } from '../types';
import { tryDefend, tryHaste } from '../systems/ai/defense';
import { DIFFICULTY, AiCtx, DifficultyParams } from '../systems/ai/types';

function cardIndexOf(pred: (c: (typeof CARD_DEFINITIONS)[number]) => boolean): number {
  const idx = CARD_DEFINITIONS.findIndex(pred);
  assert.ok(idx >= 0, 'expected a matching card in the pool');
  return idx;
}

const towerCard = CARD_DEFINITIONS[cardIndexOf((c) => c.cardType === CardType.Building && c.buildingType === BuildingType.ArrowTower)]!;
const infantryCard = CARD_DEFINITIONS[cardIndexOf((c) => c.cardType === CardType.Unit && c.unitType === UnitType.Infantry)]!;
const hasteCard = CARD_DEFINITIONS[cardIndexOf((c) => c.cardType === CardType.Spell && c.spellType === SpellType.Haste)]!;

function makeCtx(overrides: Partial<DifficultyParams> = {}): AiCtx {
  return {
    params: { ...DIFFICULTY[5]!, ...overrides },
    rng: new Prng(1),
    threatHistory: [],
  };
}

// ─── tryDefend: arrow tower branch (b) ──────────────────────────────────────────────

test('tryDefend places an arrow tower in the most-pressured open building lane when useMeteor is off', () => {
  resetUnitIds();
  const state = new GameState(1);
  state.topPlayer.hand.drawIntoSlot(0, towerCard, 999);
  state.topPlayer.addInkFp(999 * 1000);

  const threat = new Array(BOARD_COLS).fill(0);
  threat[7] = 10; // heaviest among ATTACK_LANES, no building there yet
  threat[0] = 3;

  const ctx = makeCtx({ useMeteor: false, useTowers: true });
  const cmd = tryDefend(ctx, state, 1, 42, threat);

  assert.ok(cmd, 'expected a command');
  assert.equal(cmd!.type, 'play_card');
  assert.equal((cmd as any).col, 7, 'tower should go in the most-threatened open lane');
  assert.equal((cmd as any).handIndex, 0);
  assert.equal((cmd as any).row, undefined, 'building placement never carries a row');
});

test('tryDefend skips the tower branch once every building lane is occupied, falling through to a unit block', () => {
  resetUnitIds();
  const state = new GameState(1);
  state.topPlayer.hand.drawIntoSlot(0, towerCard, 999);
  state.topPlayer.hand.drawIntoSlot(1, infantryCard, 999);
  state.topPlayer.addInkFp(999 * 1000);

  // Occupy every attack lane's building row so freeBuildingLane() returns null.
  for (const lane of ATTACK_LANES) {
    state.board.addBuilding(new Building(BuildingType.Barracks, Side.Top, lane, TOP_BUILDING_ROW));
  }

  const threat = new Array(BOARD_COLS).fill(0);
  threat[ATTACK_LANES[0]!] = 5;

  const ctx = makeCtx({ useMeteor: false, useTowers: true, useCounterPicking: false });
  const cmd = tryDefend(ctx, state, 1, 7, threat);

  assert.ok(cmd, 'expected a fallback command (unit block)');
  assert.equal(cmd!.type, 'play_card');
  assert.equal((cmd as any).handIndex, 1, 'should have fallen through to the Infantry card, not the tower');
});

// ─── tryHaste ────────────────────────────────────────────────────────────────────────

test('tryHaste returns null when no Haste card is in hand', () => {
  resetUnitIds();
  const state = new GameState(1);
  const cmd = tryHaste(state, 1, 1);
  assert.equal(cmd, null);
});

test('tryHaste returns null when a Haste card is in hand but no friendly push exists on the board', () => {
  resetUnitIds();
  const state = new GameState(1);
  state.topPlayer.hand.drawIntoSlot(0, hasteCard, 999);
  state.topPlayer.addInkFp(999 * 1000);

  const cmd = tryHaste(state, 1, 3);
  assert.equal(cmd, null, 'perCol.size === 0 with an empty board');
});

test('tryHaste returns null when the busiest friendly column only has a single unit (never wasted solo)', () => {
  resetUnitIds();
  const state = new GameState(1);
  state.topPlayer.hand.drawIntoSlot(0, hasteCard, 999);
  state.topPlayer.addInkFp(999 * 1000);

  state.board.addUnit(new Unit(UnitType.Infantry, Side.Top, 3, 5));

  const cmd = tryHaste(state, 1, 4);
  assert.equal(cmd, null);
});

test('tryHaste targets the column with the most friendly units, ignoring dead and enemy units', () => {
  resetUnitIds();
  const state = new GameState(1);
  state.topPlayer.hand.drawIntoSlot(0, hasteCard, 999);
  state.topPlayer.addInkFp(999 * 1000);

  // Column 3: two live Top units (the real push) + one dead Top unit + one Bottom unit,
  // both of which must be ignored by the perCol tally.
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Top, 3, 5));
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Top, 3, 6));
  const deadTop = new Unit(UnitType.Infantry, Side.Top, 3, 7);
  deadTop.hp_fp = toFp(0);
  state.board.addUnit(deadTop);
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 3, 8));

  // Column 5: only one live Top unit — should lose out to column 3.
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Top, 5, 5));

  const cmd = tryHaste(state, 1, 9);
  assert.ok(cmd, 'expected Haste to be cast on the busiest column');
  assert.equal(cmd!.type, 'play_card');
  assert.equal((cmd as any).col, 3);
  assert.equal((cmd as any).handIndex, 0);
});
