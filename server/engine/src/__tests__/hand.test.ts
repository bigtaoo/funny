/**
 * sim/hand.ts coverage gap: tickHandRefresh's expired-slot loop body (card_expired event
 * + re-draw via drawIntoSlot) was never exercised — every existing test only runs a
 * handful of ticks, far short of a hand slot's ~30s (CARD_REFRESH_TICKS = 900 ticks)
 * refresh timer. Rather than stepping 900 real ticks, this pins one slot's remaining
 * timer to 1 tick directly and steps once.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createGameEngine } from '../GameEngine';
import type { GameConfig } from '../types';

function pvpConfig(seed: number): GameConfig {
  return { seed, players: [{ id: 0 }, { id: 1 }] };
}

test('a hand slot whose timer reaches 0 emits card_expired and is redrawn (sim/hand.ts tickHandRefresh)', () => {
  const engine = createGameEngine(pvpConfig(30));
  engine.step(0, []); // deals both hands

  const slot = engine.state.bottomPlayer.hand.slots[0]!;
  assert.ok(slot, 'slot 0 was dealt a card on tick 0');
  slot.refreshRemainingTicks = 1; // expires on the very next tick

  const events = engine.step(1, []);

  assert.ok(events.some((e) => e.type === 'card_expired' && e.owner === 0 && e.handIndex === 0), 'card_expired fires for the expired slot');
  assert.ok(events.some((e) => e.type === 'card_drawn' && e.owner === 0 && e.handIndex === 0), 'a replacement card is drawn into the same slot');
  const newSlot = engine.state.bottomPlayer.hand.slots[0]!;
  assert.ok(newSlot, 'slot 0 is refilled, not left empty');
  assert.equal(newSlot.refreshRemainingTicks, newSlot.refreshDurationTicks, 'fresh timer set to the full CARD_REFRESH_TICKS duration');
});
