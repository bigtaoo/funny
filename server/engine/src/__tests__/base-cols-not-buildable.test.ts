/**
 * Regression: the base/castle tile must never be a legal building-placement cell.
 *
 * The base has no positional presence in Board (no Building/Unit registered at its
 * cells — see Player.baseHp, a plain HP counter) — its footprint is purely visual,
 * drawn from BASE_COLS at the building row (see BoardView.drawBases / PortraitLayout
 * playerBaseRect/enemyBaseRect). Unit placement already excludes BASE_COLS via
 * ATTACK_LANES (config.ts: "all cols except base cols 5-6"), but the Building branch
 * of processCommand's play_card handler checked only hasBuildingAt/isNoBuild — neither
 * of which ever fires for a base cell, since the base is never inserted into
 * buildingGrid or noBuildKeys. That let a Building card be committed straight onto a
 * player's own (or the mirrored enemy) base column.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createGameEngine } from '../GameEngine';
import { ATTACK_LANES, BASE_COLS } from '../config';
import { toFp } from '../math/fixed';
import { CardType } from '../types';
import type { PlayerCommand } from '../types';

/** Play `step(0)` on a fresh engine, retrying seeds until the bottom opening hand holds a building card. */
function engineWithBuildingCard(): { engine: ReturnType<typeof createGameEngine>; slotIndex: number } {
  for (let seed = 1; seed < 500; seed++) {
    const engine = createGameEngine({ seed, players: [{ id: 0 }, { id: 1 }] });
    engine.step(0, []);
    const slotIndex = engine.state.bottomPlayer.hand.slots.findIndex(
      (s) => s?.card.cardType === CardType.Building,
    );
    if (slotIndex >= 0) return { engine, slotIndex };
  }
  throw new Error('no seed < 500 dealt an opening hand containing a building card');
}

test('BASE_COLS are excluded from ATTACK_LANES (sanity for the fix below)', () => {
  for (const col of BASE_COLS) {
    assert.ok(!(ATTACK_LANES as readonly number[]).includes(col), `base col ${col} must not be an attack lane`);
  }
});

test('play_card for a Building at a base column is rejected — no building_placed event, no board occupant', () => {
  const { engine, slotIndex } = engineWithBuildingCard();
  engine.state.bottomPlayer.addInkFp(toFp(9999)); // setup only: bypass the affordability guard

  for (const baseCol of BASE_COLS) {
    const before = engine.state.board.buildings.size;
    const cmd: PlayerCommand = { type: 'play_card', owner: 0, tick: 1, handIndex: slotIndex, col: baseCol };
    const events = engine.step(1, [cmd]);

    assert.ok(
      !events.some((e) => e.type === 'building_placed'),
      `building_placed fired for base col ${baseCol} — base tile must be unbuildable`,
    );
    assert.equal(
      engine.state.board.buildings.size, before,
      `a building was added to the board at base col ${baseCol}`,
    );
    // Hand slot must still hold the card — the play was rejected, not silently consumed.
    assert.ok(engine.state.bottomPlayer.hand.slots[slotIndex], `card slot ${slotIndex} was consumed despite rejection`);
  }
});

test('play_card for a Building at a legal attack-lane column still succeeds (fix does not overreach)', () => {
  const { engine, slotIndex } = engineWithBuildingCard();
  engine.state.bottomPlayer.addInkFp(toFp(9999));

  const cmd: PlayerCommand = { type: 'play_card', owner: 0, tick: 1, handIndex: slotIndex, col: ATTACK_LANES[0] };
  const events = engine.step(1, [cmd]);

  assert.ok(events.some((e) => e.type === 'building_placed'), 'legal building placement was wrongly rejected');
});
