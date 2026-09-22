// PvP balance harness runner (PVP_LOADOUT_DESIGN §5, P4).
// Prints the analytical combat-power table and the equal-ink round-robin win
// rates, and pins both against test/pvpBaseline.json. Run with:
//   cd client && npx vitest run pvpSim
//
// Two layers of checking, on purpose (see pvpBaseline.ts): the pin catches ANY movement in
// the field, and the hand-written expectations below encode the balance DECISIONS that
// outlive any particular set of numbers.
import { describe, it, expect } from 'vitest';
import {
  pvpUnitRoster,
  combatPowerTable,
  roundRobin,
  formatCombatPower,
  formatTourney,
  harpyReport,
  medicReport,
  costSweep,
} from './pvpSim';
import {
  UPDATING, diffSection, driftMessage, readPvpBaseline, round, writePvpSection, type Section,
} from './pvpBaseline';

/** Pin `section`, or check it and fail with a per-entry diff. */
function pin(name: string, section: Section): void {
  if (UPDATING) {
    writePvpSection(name, section);
    return;
  }
  const diffs = diffSection(readPvpBaseline()[name], section);
  expect(diffs.length, driftMessage(name, diffs)).toBe(0);
}

describe('PvP balance sim (P4)', () => {
  it('combat-power-per-ink table', () => {
    const roster = pvpUnitRoster();
    const rows = combatPowerTable(roster);
    // eslint-disable-next-line no-console
    console.log('\n=== Analytical combat power (cp/ink, infantry=1.0) ===\n' + formatCombatPower(rows));
    expect(rows.length).toBe(12);
    expect(rows.find((r) => r.cardId === 'infantry_1')!.cpPerInk).toBeCloseTo(1, 1);

    // Derived straight from the blueprints, so this pin is what notices a stat edit —
    // hp/attack/armor/cost/spawnCount all land here before they reach the arena.
    pin('combatPower', Object.fromEntries(rows.map((r) => [r.cardId, {
      cost: r.cost, spawnCount: r.spawnCount, hp: round(r.hp), armor: round(r.armor),
      dps: round(r.dps), cpPerInk: round(r.cpPerInk),
    }])));
  });

  it('equal-ink round-robin win rates', () => {
    const roster = pvpUnitRoster();
    const rows = roundRobin(roster, { budget: 48 });
    // eslint-disable-next-line no-console
    console.log('\n=== Equal-ink round-robin (48 ink/side, both directions) ===\n' + formatTourney(rows));
    // Every unit should play the full field both ways: (12-1)*2 = 22 games.
    for (const r of rows) expect(r.games).toBe(22);

    // Anchor-rebalance guard (2026-07-02, BALANCE.md §5.1): Max was a stat overload
    // — a 190-HP/armor-2 tank that also out-DPSed the field at 22 melee, winning
    // ~91% of equal-ink duels at ANY cost. attack 22→14 + cost 5→6 centered it.
    // Ghost-fix re-tune (2026-07-17): the stacked-unit targeting fix lifted Max to
    // ~73% (it had been suppressed by the swarm-ghost artifact); attack 14→11 puts
    // it back at ~54%. Lock it so a future stat/cost edit can't silently revive the
    // overload.
    const max = rows.find((r) => r.cardId === 'max_1')!;
    expect(max.winRate).toBeLessThanOrEqual(0.65);
    // NOTE — do NOT "fix" infantry's high rate here. infantry_1 is the cp/ink=1.0
    // yardstick, and its ~82–91% is the AOE-less-arena swarm artifact (identical in
    // kind to splitter's accepted 100% — the real counter is Meteor, which the arena
    // cannot model). Cost 4 is also foundational to the fragile lv1 economy
    // (DIFFICULTY_SIM). Left unchanged by design (BALANCE.md §5.1 side note).

    // `wins` rather than `winRate`: same information over a fixed 22 games, and an
    // integer cannot drift by a float's last bit.
    pin('roundRobin', Object.fromEntries(rows.map((r) => [r.cardId, { games: r.games, wins: r.wins }])));
  }, 120_000);

  it('harpy guardrail probe', () => {
    const report = harpyReport();
    // eslint-disable-next-line no-console
    console.log('\n=== Harpy: flying offense vs defender profiles (48 ink) ===\n' + report);
    // Was `expect(true).toBe(true)`. The six scenarios are the only place a flying unit's
    // matchup against ground defence, AA and towers is measured at all — printing them and
    // asserting nothing meant a harpy rework showed up nowhere.
    pin('harpyReport', Object.fromEntries(report.split('\n').map((line, i) => [`line${i}`, line])));
  }, 60_000);

  it('medic value-add probe', () => {
    const report = medicReport();
    // eslint-disable-next-line no-console
    console.log('\n=== Medic: does one in the army help? (48 ink, vs shieldbearer wall) ===\n' + report);
    // Also previously `expect(true).toBe(true)`. Medic's whole design question is whether
    // one in the army pays for itself; this pins the answer so a heal-rate edit is visible.
    pin('medicReport', Object.fromEntries(report.split('\n').map((line, i) => [`line${i}`, line])));
  }, 60_000);

  it('cost sweeps confirm the P4 calls (splitter raise, runner stays 3)', () => {
    // Decisive sweeps only (full conclusions in BALANCE.md §5.2). Splitter and runner
    // drive the only judgement calls; ironclad/harpy/medic were "no change".
    const splitter = costSweep('splitter', [4, 5], { budget: 48 });
    const runner = costSweep('runner', [2, 3], { budget: 48 });
    // eslint-disable-next-line no-console
    console.log('\n' + splitter);
    // eslint-disable-next-line no-console
    console.log('\n' + runner);
    // Guard the rationale: dropping runner to 2 makes it clearly stronger than at 3.
    const at2 = roundRobin(pvpUnitRoster({ runner: 2 }), { budget: 48 }).find((r) => r.cardId === 'runner')!;
    const at3 = roundRobin(pvpUnitRoster({ runner: 3 }), { budget: 48 }).find((r) => r.cardId === 'runner')!;
    expect(at2.winRate).toBeGreaterThan(at3.winRate);

    pin('costSweeps', {
      ...Object.fromEntries(splitter.split('\n').map((l, i) => [`splitter${i}`, l])),
      ...Object.fromEntries(runner.split('\n').map((l, i) => [`runner${i}`, l])),
    });
  }, 180_000);
});
