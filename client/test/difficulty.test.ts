import { describe, it, expect } from 'vitest';
import {
  simulateLevel,
  findClearThreshold,
  formatThresholdTable,
  type ThresholdResult,
} from './difficultySim';
import { CAMPAIGN_LEVEL_ORDER } from '../src/game/campaign/levels';

/**
 * Level difficulty simulation (PvE balance tool) — see the top of difficultySim.ts for details.
 *
 * How to run:
 *   - Full difficulty report (all chapters): npx vitest run difficulty -t report
 *   - One chapter only: filter ALL_LEVELS below to a prefix, or read the console table and
 *     scan for the chapter you care about (the report always covers every chapter in one run).
 *
 * These cases also serve as a regression net: they guarantee simulator determinism and
 * guard the whole-game difficulty curve — if a future change breaks the numbers so badly that
 * no level can be cleared even with full progression, tests here will go red.
 */

// ch_stress is a headless perf-stress fixture (absurd wave counts), not a real gameplay level —
// excluded from the difficulty report. Every other campaign level (ch1–ch6) is included.
const ALL_LEVELS = CAMPAIGN_LEVEL_ORDER.filter((id) => id !== 'ch_stress');

describe('Difficulty simulator', () => {
  it('determinism: running the same level with the same preset twice gives identical results', () => {
    const a = simulateLevel('ch1_lv1', { preset: 'fresh' });
    const b = simulateLevel('ch1_lv1', { preset: 'fresh' });
    expect(a).toEqual(b);
  });

  it('monotonicity: higher progression means level 1 minimum base HP does not decrease (more stable)', () => {
    const fresh = simulateLevel('ch1_lv1', { preset: 'fresh' });
    const t5 = simulateLevel('ch1_lv1', { preset: 'T5' });
    // Full progression must be at least as good as zero progression (minBaseHp does not decrease; win does not regress).
    expect(t5.minBaseHp).toBeGreaterThanOrEqual(fresh.minBaseHp);
    if (fresh.win) expect(t5.win).toBe(true);
  });

  it('report: full-game difficulty matrix — each level × progression preset', () => {
    const results: ThresholdResult[] = ALL_LEVELS.map((id) => findClearThreshold(id));
    // Print to stdout (vitest shows console output by default).
    console.log('\n' + formatThresholdTable(results) + '\n');
    console.log('Legend: each cell = 5-seed evaluation. N★P% = median N stars / clear rate P%; ✗P% = majority fail (clear rate P%).');
    console.log('     minClear = lowest preset with clear rate ≥50%. Note: baseline AI is conservative; absolute values are for relative comparison only.\n');

    // Sanity regression guard: baseline AI must clear at least one level at some preset
    // (proves the AI and simulation pipeline are connected).
    // We do not assert specific levels here — difficulty itself is the evaluation target.
    const anyClear = results.some((r) => r.minClearPreset !== null);
    expect(anyClear, 'baseline AI cannot clear any level — simulator/AI pipeline broken').toBe(true);
  });
});
