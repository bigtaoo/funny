/**
 * Covers AISystem.ts's step-3 offensive-meteor branch (previously entirely unreached:
 * every existing AISystem scenario either never carried a Meteor card past emergency
 * defense, or never had a qualifying cluster once decision fell through to step 3).
 * Drives the full public decideTick() pipeline (not the inner functions directly) so
 * this exercises the actual priority ordering: no near-base pressure -> upgrade check
 * short-circuited by nonzero threat -> no barracks card -> offensive meteor fires.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { AISystem, DIFFICULTY } from '../systems/AISystem';
import { GameState } from '../GameState';
import { Unit, resetUnitIds } from '../Unit';
import { Prng } from '../math/prng';
import { CARD_DEFINITIONS } from '../config';
import { AIDifficulty, CardType, Side, SpellType, UnitType } from '../types';

const meteorCard = CARD_DEFINITIONS.find(
  (c) => c.cardType === CardType.Spell && c.spellType === SpellType.Meteor,
)!;

/** A 2x2 cluster of 4 Infantry (cost 4 each = 16 total) far from the AI base (row 17),
 *  so it never trips emergency defense but always clears a value-trade gate at 12*1.3=15.6. */
function buildFarClusterState(): GameState {
  const state = new GameState(11);
  state.topPlayer.hand.drawIntoSlot(0, meteorCard, 999);
  state.topPlayer.addInkFp(999 * 1000);
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 2, 0));
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 3, 0));
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 2, 1));
  state.board.addUnit(new Unit(UnitType.Infantry, Side.Bottom, 3, 1));
  return state;
}

function driveToDecision(ai: AISystem, state: GameState, level: AIDifficulty): unknown[] {
  let last: unknown[] = [];
  for (let tick = 0; tick < DIFFICULTY[level]!.thinkIntervalTicks; tick++) {
    last = ai.decideTick(tick, state);
  }
  return last;
}

test('AISystem offensive meteor (L5, useValueTrades off): fires on a far cluster once emergency defense/upgrade/barracks are all ruled out', () => {
  resetUnitIds();
  const state = buildFarClusterState();
  // L5: dangerRow 12, cluster sits at rows 0-1 -> imminent = 0; baseHp full -> not underPressure.
  const ai = new AISystem(new Prng(5), 5);

  const cmds = driveToDecision(ai, state, 5);
  assert.equal(cmds.length, 1);
  const cmd = cmds[0] as any;
  assert.equal(cmd.type, 'play_card');
  assert.equal(cmd.handIndex, 0);
  assert.equal(cmd.col, 2);
  assert.equal(cmd.row, 0);
});

test('AISystem offensive meteor (L10, useValueTrades on): the ink-value-gated ternary branch also fires when the cluster clears the threshold', () => {
  resetUnitIds();
  const state = buildFarClusterState();
  // L10: dangerRow 4 -> cluster at rows 0-1 still stays under it -> not underPressure.
  const ai = new AISystem(new Prng(5), 10);

  const cmds = driveToDecision(ai, state, 10);
  assert.equal(cmds.length, 1);
  const cmd = cmds[0] as any;
  assert.equal(cmd.type, 'play_card');
  assert.equal(cmd.handIndex, 0);
  assert.equal(cmd.col, 2);
  assert.equal(cmd.row, 0);
});
