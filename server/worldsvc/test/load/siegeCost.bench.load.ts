// Siege battle cost on ONE core — the number the 3000-player plan needs for the compute wall (ADR-092 /
// audit §12.7 phase 0). The order load test only triggers occupations of empty land, whose NPC battles
// cost ~3ms; an evenly matched siege runs the full deterministic engine and had never been timed. Prod has
// a single compute worker (2 vCPU → cpus-1), so 1000 / (ms per battle) is the whole server's ceiling in
// battles per second, across every world.
//
// Opt-in, no stack needed: `npx vitest run --config vitest.load.config.ts test/load/siegeCost.bench.load.ts`.
import { describe, it, expect } from 'vitest';
import { runSiegeBattleSync, synthesizeArmy, SIEGE_SYNTH_ARMY_MAX_TROOPS, type SiegeBattleInput } from '../../src/siegeEngine';

function battle(attacker: number, defender: number, seed: number): SiegeBattleInput {
  return {
    attackerArmy: synthesizeArmy(attacker, 'attacker'),
    defenderConfig: { garrison: synthesizeArmy(defender, 'defender') },
    tileLevel: 1,
    seed,
  };
}

describe('siege battle cost on one core', () => {
  it('times even and lopsided battles at several sizes', () => {
    const max = SIEGE_SYNTH_ARMY_MAX_TROOPS;
    const cases: [string, number, number][] = [
      ['even, 500 v 500', 500, 500],
      ['even, 25% board', Math.round(max / 4), Math.round(max / 4)],
      ['even, 50% board', Math.round(max / 2), Math.round(max / 2)],
      ['even, full board', max, max],
      ['2:1 full board', max, Math.round(max / 2)],
    ];
    runSiegeBattleSync(battle(500, 500, 1)); // JIT warm-up
    /* eslint-disable no-console */
    console.log(`[siege] SIEGE_SYNTH_ARMY_MAX_TROOPS = ${max}`);
    for (const [name, a, d] of cases) {
      const ms: number[] = [];
      for (let seed = 1; seed <= 5; seed++) {
        const t0 = performance.now();
        runSiegeBattleSync(battle(a, d, seed));
        ms.push(performance.now() - t0);
      }
      ms.sort((x, y) => x - y);
      console.log(`[siege] ${name.padEnd(18)} median ${ms[2]!.toFixed(1)}ms  max ${ms[4]!.toFixed(1)}ms  → ${(1000 / ms[2]!).toFixed(1)} battles/s per worker`);
      expect(ms[2]).toBeGreaterThan(0);
    }
    /* eslint-enable no-console */
  });
});
