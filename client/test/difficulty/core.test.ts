import { describe, it, expect } from 'vitest';
import { simulateLevel } from '../difficultySim';

/**
 * Level difficulty simulation (PvE balance tool) — see the top of difficultySim.ts for details.
 *
 * How to run:
 *   - Full difficulty report (all chapters): npx vitest run test/difficulty
 *   - One chapter only: npx vitest run test/difficulty/ch3.test.ts
 *
 * The full-game report (findClearThreshold over every level × preset × seed) is split one
 * file per chapter (ch1..ch6.test.ts, sharing describeChapterDifficulty from chapterReport.ts)
 * instead of one big test — that lets vitest's per-file worker-thread scheduling run all six
 * chapters' simulations concurrently rather than serially in one thread (was ~150s single-file).
 *
 * These cases also serve as a regression net: they guarantee simulator determinism and
 * guard the whole-game difficulty curve — if a future change breaks the numbers so badly that
 * no level can be cleared even with full progression, the per-chapter report tests go red.
 */
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
});
