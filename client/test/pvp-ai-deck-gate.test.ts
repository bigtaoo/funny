// Regression guard for the match-bot fallback leaking ELO-locked cards
// (PVP_LOADOUT_DESIGN §3/§6.3).
//
// Repro of the reported bug: a ranked queue that times out (30s) falls back to a
// LOCAL PvP-vs-AI match (server pushes match_bot with no deck). That local match
// is built by createLocalMatch(); before the fix it passed no `decks`, so the
// engine's PvP path fell back to the FULL CARD_DEFINITIONS pool and drew
// ELO-locked units (runner/splitter/…) for a sub-1500 player.
//
// The fix threads the player's current-elo-validated deck into createLocalMatch
// as `decks` (mirror match: bottom = human, top = AI), filtering both draw pools.

import { describe, it, expect } from 'vitest';
import { createLocalMatch } from '../src/app/matchEngine';
import { PVP_BASE_CARDS, PVP_UNLOCK_TIERS } from '../src/game/meta/pvpLoadout';
import { TICK_RATE } from '../src/game/math/fixed';

const LOCKED_CARDS = PVP_UNLOCK_TIERS.flatMap((t) => t.cards); // runner, ironclad, berserker, splitter, harpy, medic
const BASE = [...PVP_BASE_CARDS];
const STEP = 1 / TICK_RATE;

/** Draw `n` cards from a policy and return the set of card ids produced. */
function drawIds(policy: { draw(): { id: string } }, n: number): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) seen.add(policy.draw().id);
  return seen;
}

describe('PvP-vs-AI (match-bot fallback) deck gating', () => {
  it('restricts BOTH draw pools to the supplied deck — no ELO-locked cards', () => {
    const { engine } = createLocalMatch({ decks: { top: BASE, bottom: BASE }, seed: 0x1234 });
    const baseSet = new Set(BASE);

    for (const player of [engine.state.bottomPlayer, engine.state.topPlayer]) {
      const seen = drawIds(player.drawPolicy, 2000);
      // Every drawn id is in the deck …
      for (const id of seen) expect(baseSet.has(id)).toBe(true);
      // … and none of the tier-locked units ever surface.
      for (const locked of LOCKED_CARDS) expect(seen.has(locked)).toBe(false);
    }
  });

  it('never shows a locked card in either hand across a full simulated match', () => {
    // Bottom = human (static hand after the opening draw), top = AI (plays → refills,
    // exercising the top draw pool). With base decks, no locked unit may ever appear.
    const { engine } = createLocalMatch({ decks: { top: BASE, bottom: BASE }, seed: 0xBEEF });
    const baseSet = new Set(BASE);
    const lockedSet = new Set(LOCKED_CARDS);

    for (let t = 0; t < 1500; t++) {
      engine.tick(STEP);
      for (const player of [engine.state.bottomPlayer, engine.state.topPlayer]) {
        for (const slot of player.hand.slots) {
          const id = slot?.card.id;
          if (id === undefined) continue;
          expect(lockedSet.has(id)).toBe(false);
          expect(baseSet.has(id)).toBe(true);
        }
      }
    }
  });

  it('WITHOUT decks the engine draws from the full pool (documents the old leak)', () => {
    // The regression this test guards: if the `decks` plumbing is ever dropped, the
    // PvP path reverts to the full CARD_DEFINITIONS pool and locked units reappear.
    const { engine } = createLocalMatch({ seed: 0x1234 });
    const seen = drawIds(engine.state.bottomPlayer.drawPolicy, 4000);
    // Full pool → at least one tier-locked unit is reachable.
    expect(LOCKED_CARDS.some((id) => seen.has(id))).toBe(true);
  });
});
