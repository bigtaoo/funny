// Unit tests (pure, no Mongo, no worker pool — runSiegeBattleSync is the synchronous function that
// runs INSIDE the worker; siegeWorkerPool.test.ts already cross-checks it against the pool's async
// wrapper, but only ever with perfectly evenly-matched "bigEvenBattle" armies, which happens to only
// exercise the attacker_win outcome branch (see src/siegeEngine.ts's outcome ternary just before the
// two `return` statements) — never the defender-holds branch. Both are pinned directly here.
import { describe, expect, it } from 'vitest';
import { runSiegeBattleSync, synthesizeArmy, SIEGE_SYNTH_ARMY_MAX_TROOPS } from '../src/siegeEngine';

describe('runSiegeBattleSync — both outcome branches', () => {
  it('attacker overwhelms the defender → attacker_win, defenderSurvivors is always 0', () => {
    const res = runSiegeBattleSync({
      attackerArmy: synthesizeArmy(SIEGE_SYNTH_ARMY_MAX_TROOPS, 'attacker'),
      defenderConfig: { garrison: synthesizeArmy(10, 'defender') },
      tileLevel: 1,
      seed: 1,
    });
    expect(res.outcome).toBe('attacker_win');
    expect(res.defenderSurvivors).toBe(0);
    expect(res.attackerSurvivors).toBeGreaterThan(0);
  });

  it('defender overwhelms a weak attacker → defender_win, attackerSurvivors is always 0, defender keeps real survivors', () => {
    const res = runSiegeBattleSync({
      attackerArmy: synthesizeArmy(10, 'attacker'),
      defenderConfig: { garrison: synthesizeArmy(SIEGE_SYNTH_ARMY_MAX_TROOPS, 'defender') },
      tileLevel: 1,
      seed: 1,
    });
    expect(res.outcome).toBe('defender_win');
    expect(res.attackerSurvivors).toBe(0);
    expect(res.defenderSurvivors).toBeGreaterThan(0);
  });
});
