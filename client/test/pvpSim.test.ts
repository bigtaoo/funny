// PvP balance harness runner (PVP_LOADOUT_DESIGN §5, P4).
// Prints the analytical combat-power table and the equal-ink round-robin win
// rates, with light guards so the harness can't silently rot. Run with:
//   cd client && npx vitest run pvpSim
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

describe('PvP balance sim (P4)', () => {
  it('combat-power-per-ink table', () => {
    const roster = pvpUnitRoster();
    const rows = combatPowerTable(roster);
    // eslint-disable-next-line no-console
    console.log('\n=== Analytical combat power (cp/ink, infantry=1.0) ===\n' + formatCombatPower(rows));
    expect(rows.length).toBe(12);
    expect(rows.find((r) => r.cardId === 'infantry_1')!.cpPerInk).toBeCloseTo(1, 1);
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
    // ~91% of equal-ink duels at ANY cost. attack 22→14 + cost 5→6 centers it.
    // Lock it so a future stat/cost edit can't silently revive the overload.
    const max = rows.find((r) => r.cardId === 'max_1')!;
    expect(max.winRate).toBeLessThanOrEqual(0.65);
    // NOTE — do NOT "fix" infantry's high rate here. infantry_1 is the cp/ink=1.0
    // yardstick, and its ~82–91% is the AOE-less-arena swarm artifact (identical in
    // kind to splitter's accepted 100% — the real counter is Meteor, which the arena
    // cannot model). Cost 4 is also foundational to the fragile lv1 economy
    // (DIFFICULTY_SIM). Left unchanged by design (BALANCE.md §5.1 side note).
  }, 120_000);

  it('harpy guardrail probe', () => {
    // eslint-disable-next-line no-console
    console.log('\n=== Harpy: flying offense vs defender profiles (48 ink) ===\n' + harpyReport());
    expect(true).toBe(true);
  }, 60_000);

  it('medic value-add probe', () => {
    // eslint-disable-next-line no-console
    console.log('\n=== Medic: does one in the army help? (48 ink, vs shieldbearer wall) ===\n' + medicReport());
    expect(true).toBe(true);
  }, 60_000);

  it('cost sweeps confirm the P4 calls (splitter raise, runner stays 3)', () => {
    // Decisive sweeps only (full conclusions in BALANCE.md §5.2). Splitter and runner
    // drive the only judgement calls; ironclad/harpy/medic were "no change".
    // eslint-disable-next-line no-console
    console.log('\n' + costSweep('splitter', [4, 5], { budget: 48 }));
    // eslint-disable-next-line no-console
    console.log('\n' + costSweep('runner', [2, 3], { budget: 48 }));
    // Guard the rationale: dropping runner to 2 makes it clearly stronger than at 3.
    const at2 = roundRobin(pvpUnitRoster({ runner: 2 }), { budget: 48 }).find((r) => r.cardId === 'runner')!;
    const at3 = roundRobin(pvpUnitRoster({ runner: 3 }), { budget: 48 }).find((r) => r.cardId === 'runner')!;
    expect(at2.winRate).toBeGreaterThan(at3.winRate);
  }, 180_000);
});
