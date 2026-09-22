// Difficulty regression gate — the piece `chapterReport.ts` was missing.
//
// Until 2026-09-22 the matrix was printed and nothing about it was asserted; the only
// check was "the baseline AI clears at least one level", on the reasoning that difficulty
// is the thing being evaluated, so pinning it would fight the tuning work. That reasoning
// holds for hand-tuning a level. It does not hold for the failure this gate exists for:
// an ENGINE change silently moving the whole campaign. The lane-overflow side-step
// (DESIGN.md §6c) dropped the clear gate a tier or more on 19 of 61 levels and every
// suite in the repo stayed green — it was caught by a human diffing two matrix reports
// by hand, which is exactly the kind of vigilance a gate should not depend on.
//
// Pinned EXACTLY rather than with a tolerance, because the simulation is deterministic:
// `findClearThreshold` runs the fixed EVAL_SEEDS against a fixed-point engine, so the
// same levels + same engine reproduce the table byte for byte (verified: after the
// 2026-09-22 re-tune, a fresh full run matched the chosen configuration on 60/60 rows).
// A tolerance would only buy room for drift nobody looked at.
//
// ── When this goes red ──────────────────────────────────────────────────────────────
// It is telling you the campaign's difficulty moved. That is either the point of your
// change or a side effect you had not noticed — decide which BEFORE touching this file.
// Once you have decided it is intended:
//
//   cd client && NW_UPDATE_DIFFICULTY_BASELINE=1 npx vitest run --config vitest.sim.config.ts
//
// and commit the regenerated `baseline.json` alongside the change that moved it, the same
// way engine/src/__tests__/goldenReplay fixtures are re-recorded. Regenerating it to make
// a red run green, without understanding what moved, defeats the whole point.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThresholdResult } from '../difficultySim';

const BASELINE_PATH = join(__dirname, 'baseline.json');

/** One level's pinned outcome: the clear gate plus the per-preset cells, as printed. */
export interface LevelBaseline {
  /** `minClearPreset`, or 'unbeatable' when no preset clears it. */
  gate: string;
  /** Six cells in PRESET_ORDER, formatted like the report: `2★80%` / `✗40%`. */
  cells: string[];
}

export type Baseline = Record<string, LevelBaseline>;

export const UPDATING = process.env.NW_UPDATE_DIFFICULTY_BASELINE === '1';

export function readBaseline(): Baseline {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  } catch {
    return {};
  }
}

/**
 * Merge one chapter's rows into the on-disk baseline.
 *
 * Chapters run in separate vitest worker threads (that is the whole reason the report is
 * split per file), so each one read-modify-writes the shared file rather than replacing
 * it — otherwise the last chapter to finish would be the only one recorded. The window
 * for two workers interleaving is real but tiny, and the cost of losing it is a rerun of
 * an explicitly-requested regeneration, not a wrong green.
 */
export function writeChapterBaseline(rows: Baseline): void {
  const merged = { ...readBaseline(), ...rows };
  const ordered: Baseline = {};
  for (const id of Object.keys(merged).sort(byChapterThenLevel)) ordered[id] = merged[id]!;
  writeFileSync(BASELINE_PATH, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
}

/** `ch2_lv10` sorts after `ch2_lv9`, and every ch1 before any ch2. */
function byChapterThenLevel(a: string, b: string): number {
  const parse = (s: string) => {
    const m = /^ch(\d+)_lv(\d+)$/.exec(s);
    return m ? [Number(m[1]), Number(m[2])] : [99, 99];
  };
  const [ca, la] = parse(a);
  const [cb, lb] = parse(b);
  return ca !== cb ? ca! - cb! : la! - lb!;
}

/** The report's own cell formatting, so the pinned strings read exactly like the printed table. */
export function toBaselineRows(results: ThresholdResult[]): Baseline {
  const rows: Baseline = {};
  for (const tr of results) {
    rows[tr.levelId] = {
      gate: tr.minClearPreset ?? 'unbeatable',
      cells: tr.byPreset.map((c) => (c.winRate >= 0.5
        ? `${c.medianStars}★${Math.round(c.winRate * 100)}%`
        : `✗${Math.round(c.winRate * 100)}%`)),
    };
  }
  return rows;
}

/** Human-readable diff for the failure message — the gate move first, since that is the headline. */
export function describeDrift(id: string, want: LevelBaseline, got: LevelBaseline): string {
  const parts: string[] = [];
  if (want.gate !== got.gate) parts.push(`clear gate ${want.gate} -> ${got.gate}`);
  const cellDiffs = want.cells
    .map((w, i) => (w === got.cells[i] ? null : `${['fresh', 'T2', 'T3', 'T4', 'T5', 'T6'][i]}: ${w} -> ${got.cells[i]}`))
    .filter(Boolean);
  if (cellDiffs.length > 0) parts.push(cellDiffs.join(', '));
  return `  ${id}: ${parts.join(' | ')}`;
}
