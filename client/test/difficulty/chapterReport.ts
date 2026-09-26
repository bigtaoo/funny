import { describe, it, expect } from 'vitest';
import { findClearThreshold, formatThresholdTable, type ThresholdResult } from '../difficultySim';
import { CAMPAIGN_LEVEL_ORDER } from '@nw/engine/campaign/levels';
import {
  UPDATING, describeDrift, readBaseline, toBaselineRows, writeChapterBaseline,
} from './baseline';

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
      const anyClear = results.some((r) => r.minClearPreset !== null);
      expect(anyClear, `baseline AI cannot clear any ch${chapter} level — simulator/AI pipeline broken`).toBe(true);

      // ── Difficulty regression gate (2026-09-22) ────────────────────────────────────
      // The matrix used to be printed and nothing about it asserted. See baseline.ts for
      // why that had to change and how to regenerate the pin deliberately.
      const rows = toBaselineRows(results);
      if (UPDATING) {
        writeChapterBaseline(rows);
        return;
      }

      const baseline = readBaseline();
      const missing = levels.filter((id) => !baseline[id]);
      expect(
        missing,
        `ch${chapter} levels have no pinned difficulty: ${missing.join(', ')}. `
        + 'A new level must be recorded on purpose — rerun with NW_UPDATE_DIFFICULTY_BASELINE=1.',
      ).toEqual([]);

      const drifted = levels
        .filter((id) => baseline[id] && JSON.stringify(baseline[id]) !== JSON.stringify(rows[id]))
        .map((id) => describeDrift(id, baseline[id]!, rows[id]!));

      expect(
        drifted.length,
        `ch${chapter} difficulty moved on ${drifted.length} level(s):\n${drifted.join('\n')}\n\n`
        + 'The simulation is deterministic, so this is a real change in how the campaign plays — '
        + 'from this change or from an engine change underneath it. Work out which before touching '
        + 'the pin; if it is intended, regenerate with:\n'
        + '  cd client && NW_UPDATE_DIFFICULTY_BASELINE=1 npx vitest run --config vitest.sim.config.ts',
      ).toBe(0);
    });
  });
}
