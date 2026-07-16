import { describe, it, expect } from 'vitest';
import { findClearThreshold, formatThresholdTable, type ThresholdResult } from '../difficultySim';
import { CAMPAIGN_LEVEL_ORDER } from '../../src/game/campaign/levels';

// Shared by ch1..ch6.test.ts (see difficulty/README comment in core.test.ts for why the
// full-game report is split one file per chapter): each call registers one chapter's report
// test in its own file, so vitest's per-file worker-thread scheduling runs all six chapters'
// simulations concurrently instead of one ~150s block in a single file/thread.
export function describeChapterDifficulty(chapter: number): void {
  const prefix = `ch${chapter}_`;
  const levels = CAMPAIGN_LEVEL_ORDER.filter((id) => id.startsWith(prefix));

  describe(`Difficulty simulator — chapter ${chapter}`, () => {
    it(`report: ch${chapter} difficulty matrix — each level × progression preset`, () => {
      const results: ThresholdResult[] = levels.map((id) => findClearThreshold(id));
      // Print to stdout (vitest shows console output by default).
      console.log(`\n${formatThresholdTable(results)}\n`);

      // Sanity regression guard: baseline AI must clear at least one level at some preset
      // (proves the AI and simulation pipeline are connected).
      // We do not assert specific levels here — difficulty itself is the evaluation target.
      const anyClear = results.some((r) => r.minClearPreset !== null);
      expect(anyClear, `baseline AI cannot clear any ch${chapter} level — simulator/AI pipeline broken`).toBe(true);
    });
  });
}
