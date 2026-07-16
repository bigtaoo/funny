// Unit tests (pure functions, no Mongo) for the SIEGE_CHEAP_RATIO / board-overflow guard (shouldUseCheapSiege).
// Bug: `synthesizeArmy`'s round-robin placement (10 attack lanes × 16 spawnable rows × 60 HP/unit = 9,600 troops)
// overflows once a single siege army exceeds board capacity — units stack onto the same lane/row, congest, and the
// battle can hit its hard time limit (defender advantage) regardless of true combat strength, producing
// non-monotonic win/loss outcomes as troop count grows (9,000 loses, 9,600 wins, 10,000 loses again). A maxed
// drillYard + satchel raises both troopCap and per-march carry cap to 12,000 (server/shared/src/slg/city.ts),
// so this is reachable in production via a plain (no-team) attack march. `shouldUseCheapSiege` routes such
// synthesized armies — and any ratio-overwhelming fight — to the cheap linear `resolveSiege` instead of the engine.
import { describe, expect, it } from 'vitest';
import { SIEGE_CHEAP_RATIO } from '@nw/shared';
import { shouldUseCheapSiege, SIEGE_SYNTH_ARMY_MAX_TROOPS, synthesizeArmy } from '../src/siegeEngine';

describe('SIEGE_SYNTH_ARMY_MAX_TROOPS (board capacity)', () => {
  it('matches synthesizeArmy: at capacity every unit gets a unique lane/row, beyond it units collide', () => {
    const atCapacity = synthesizeArmy(SIEGE_SYNTH_ARMY_MAX_TROOPS, 'attacker');
    const cells = new Set(atCapacity.map((e) => `${e.col}:${e.row}`));
    expect(cells.size).toBe(atCapacity.length); // no collisions yet

    const overCapacity = synthesizeArmy(SIEGE_SYNTH_ARMY_MAX_TROOPS + 60, 'attacker');
    const overCells = new Set(overCapacity.map((e) => `${e.col}:${e.row}`));
    expect(overCells.size).toBeLessThan(overCapacity.length); // collision: board depth exhausted
  });
});

describe('shouldUseCheapSiege', () => {
  it('synthesized attacker beyond board capacity → cheap, even against a weak defender (ratio far below 10)', () => {
    const attackerTroops = SIEGE_SYNTH_ARMY_MAX_TROOPS + 1000; // ~10,600: the reported 9,000/9,600/10,000 flip-flop zone
    const defenderTroops = attackerTroops / 2; // ratio ~2, nowhere near SIEGE_CHEAP_RATIO
    expect(
      shouldUseCheapSiege({ attackerTroops, defenderTroops, attackerSynthesized: true, defenderSynthesized: false }),
    ).toBe(true);
  });

  it('synthesized defender beyond board capacity → cheap (future-proofs a raised stronghold/crossing garrison constant)', () => {
    const defenderTroops = SIEGE_SYNTH_ARMY_MAX_TROOPS + 500;
    const attackerTroops = defenderTroops / 2;
    expect(
      shouldUseCheapSiege({ attackerTroops, defenderTroops, attackerSynthesized: false, defenderSynthesized: true }),
    ).toBe(true);
  });

  it('real (non-synthesized) armies beyond board capacity do NOT trigger the overflow guard (explicit, validated positions never collide)', () => {
    const attackerTroops = SIEGE_SYNTH_ARMY_MAX_TROOPS + 1000;
    const defenderTroops = attackerTroops / 2;
    expect(
      shouldUseCheapSiege({ attackerTroops, defenderTroops, attackerSynthesized: false, defenderSynthesized: false }),
    ).toBe(false);
  });

  it('ratio ≥ SIEGE_CHEAP_RATIO → cheap regardless of synthesis (existing overwhelming-force design)', () => {
    expect(
      shouldUseCheapSiege({
        attackerTroops: 1000 * SIEGE_CHEAP_RATIO,
        defenderTroops: 1000,
        attackerSynthesized: false,
        defenderSynthesized: false,
      }),
    ).toBe(true);
  });

  it('small, comparable, real armies well under capacity → engine runs (not cheap)', () => {
    expect(
      shouldUseCheapSiege({ attackerTroops: 1000, defenderTroops: 900, attackerSynthesized: true, defenderSynthesized: true }),
    ).toBe(false);
  });
});
