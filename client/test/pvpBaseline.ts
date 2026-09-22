// PvP balance regression gate — the counterpart to test/difficulty/baseline.ts.
//
// `pvpSim.test.ts` printed five tables and asserted three points in them: the cp/ink
// yardstick, Max's win-rate ceiling, and runner-at-2 beating runner-at-3. Two of its five
// cases were `expect(true).toBe(true)`. So any stat or cost edit that did not push Max
// past 0.65 or invert the runner sweep moved the whole PvP field silently — which is the
// same hole the campaign matrix had (see test/difficulty/baseline.ts).
//
// Pinned exactly, for the same reason: the arena is deterministic (fixed-point engine,
// scripted armies, no RNG in the duel loop — two consecutive runs produce byte-identical
// tables, checked before this file was written).
//
// ── The pin and the hand-written assertions do different jobs ───────────────────────
// The pin says "nothing moved". The three hand-written expectations in pvpSim.test.ts say
// "even when it moves, it may not cross THIS line" — they encode balance decisions
// (BALANCE.md §5.1/§5.2) and outlive any particular set of numbers. Keep both: replacing
// the decisions with a snapshot would lose why the numbers are allowed to be what they are.
//
// ── When this goes red ──────────────────────────────────────────────────────────────
// The PvP field moved. Work out whether that was the point of your change before touching
// the pin; once you have decided it is intended:
//
//   cd client && NW_UPDATE_PVP_BASELINE=1 npx vitest run --config vitest.sim.config.ts pvpSim
//
// and commit the regenerated `pvpBaseline.json` next to the change that moved it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE_PATH = join(__dirname, 'pvpBaseline.json');

export const UPDATING = process.env.NW_UPDATE_PVP_BASELINE === '1';

export type Section = Record<string, unknown>;

export function readPvpBaseline(): Record<string, Section> {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, Section>;
  } catch {
    return {};
  }
}

/**
 * Merge one section (`combatPower`, `roundRobin`, …) into the pinned file.
 *
 * The five cases live in one describe block and run in order in a single worker, so this
 * could just as well collect and write once at the end; merging per section keeps it
 * symmetric with the campaign gate and survives the file being split later.
 */
export function writePvpSection(name: string, section: Section): void {
  const merged = { ...readPvpBaseline(), [name]: section };
  writeFileSync(BASELINE_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

/** Round to `places` so a float's last bits cannot make a deterministic table look unstable. */
export function round(v: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/**
 * Compare a section against its pin and return one line per difference.
 *
 * Keyed rather than whole-blob so the failure names the card that moved. Report bodies
 * (harpy / medic / cost sweeps) are pinned as line arrays for the same reason — a diff
 * that says "line 3 changed" beats one that says "the string changed".
 */
export function diffSection(want: Section | undefined, got: Section): string[] {
  if (!want) return ['(no pin recorded for this section — rerun with NW_UPDATE_PVP_BASELINE=1)'];
  const out: string[] = [];
  for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
    const a = JSON.stringify(want[key]);
    const b = JSON.stringify(got[key]);
    if (a === b) continue;
    if (a === undefined) out.push(`  + ${key}: ${b} (not in the pin)`);
    else if (b === undefined) out.push(`  - ${key}: ${a} (gone)`);
    else out.push(`  ${key}: ${a} -> ${b}`);
  }
  return out;
}

/** Shared failure text so all five cases point at the same recovery procedure. */
export function driftMessage(section: string, diffs: string[]): string {
  return `PvP ${section} moved on ${diffs.length} entr${diffs.length === 1 ? 'y' : 'ies'}:\n${diffs.join('\n')}\n\n`
    + 'The arena is deterministic, so this is a real change in how the PvP field plays. '
    + 'Decide whether that was the point of the change before touching the pin; if it was, '
    + 'regenerate with:\n'
    + '  cd client && NW_UPDATE_PVP_BASELINE=1 npx vitest run --config vitest.sim.config.ts pvpSim';
}
