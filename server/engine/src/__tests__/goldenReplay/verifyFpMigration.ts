// ADR-065 one-off verification — NOT part of the test suite (not a *.test.ts, not in
// package.json's `test` script). Run this ONCE, before regenerating the golden replay
// fixtures with generateFixtures.ts, to prove the fixed-point migration is a pure
// representation change (modulo the INTENDED loss of premature intermediate rounding —
// see the tolerance note below): every scenario's final state, converted back to real
// units, must match the CURRENTLY-COMMITTED (pre-migration) fixture within a small
// tolerance — same winner, same tick count, same event-count-affecting state (deaths,
// kill counts, ids, positions), with only live-unit HP allowed to differ by <1 real HP
// point (multi-step damage chains — e.g. burstOnSingleMult × markEnemies — no longer
// round at each intermediate step, so a compound hit's exact HP can land on a fractional
// value like 90.5 instead of the old Math.round()-at-each-step 90 or 91; this is the
// explicit point of ADR-065, not a bug). If ANY field outside that tolerance diverges,
// or if winner/ticksRun/any non-hp field differs at all, do NOT regenerate fixtures —
// investigate first.
//
//   cd server/engine && npx tsx src/__tests__/goldenReplay/verifyFpMigration.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS } from './scenarios';
import { runScenario } from './runScenario';
import { fromFp } from '../../math/fixed';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const HP_TOLERANCE = 1; // real HP points — see header comment

/** Strips one `_fp`-suffixed key and replaces it with its real-unit equivalent under the pre-ADR-065 name. */
function unscale(obj: Record<string, unknown>, fpKey: string, realKey: string): Record<string, unknown> {
  const { [fpKey]: fpVal, ...rest } = obj;
  return { ...rest, [realKey]: fromFp(fpVal as never) };
}

function convertSnapshot(snap: Record<string, unknown>): Record<string, unknown> {
  return {
    ...snap,
    bottomPlayer: unscale(unscale(snap.bottomPlayer as Record<string, unknown>, 'baseHp_fp', 'baseHp'), 'maxBaseHp_fp', 'maxBaseHp'),
    topPlayer: unscale(unscale(snap.topPlayer as Record<string, unknown>, 'baseHp_fp', 'baseHp'), 'maxBaseHp_fp', 'maxBaseHp'),
    units: (snap.units as Record<string, unknown>[]).map((u) => unscale(u, 'hp_fp', 'hp')),
    buildings: (snap.buildings as Record<string, unknown>[]).map((b) => unscale(b, 'hp_fp', 'hp')),
    escorts: (snap.escorts as Record<string, unknown>[]).map((e) => unscale(e, 'hp_fp', 'hp')),
  };
}

/** Recursively diffs two values, collecting {path, old, new} for every leaf that differs. */
function diff(oldVal: unknown, newVal: unknown, path: string, out: { path: string; old: unknown; new: unknown }[]): void {
  if (Array.isArray(oldVal) && Array.isArray(newVal)) {
    const len = Math.max(oldVal.length, newVal.length);
    for (let i = 0; i < len; i++) diff(oldVal[i], newVal[i], `${path}[${i}]`, out);
    return;
  }
  if (oldVal !== null && newVal !== null && typeof oldVal === 'object' && typeof newVal === 'object') {
    const keys = new Set([...Object.keys(oldVal as object), ...Object.keys(newVal as object)]);
    for (const k of keys) {
      diff((oldVal as Record<string, unknown>)[k], (newVal as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
    }
    return;
  }
  if (oldVal !== newVal) out.push({ path, old: oldVal, new: newVal });
}

let allOk = true;
for (const scenario of SCENARIOS) {
  const result = runScenario(scenario);
  const oldPath = join(FIXTURES_DIR, `${scenario.name}.json`);
  const old = JSON.parse(readFileSync(oldPath, 'utf8')) as { ticksRun: number; finalSnapshot: Record<string, unknown> };

  const hardProblems: string[] = [];
  if (old.ticksRun !== result.ticksRun) hardProblems.push(`ticksRun: old=${old.ticksRun} new=${result.ticksRun}`);

  const converted = convertSnapshot(result.finalSnapshot as Record<string, unknown>);
  const diffs: { path: string; old: unknown; new: unknown }[] = [];
  diff(old.finalSnapshot, converted, '', diffs);

  const softProblems: string[] = [];
  for (const d of diffs) {
    const isHpField = /\.hp$/.test(d.path) && typeof d.old === 'number' && typeof d.new === 'number';
    if (isHpField && Math.abs((d.old as number) - (d.new as number)) < HP_TOLERANCE) {
      softProblems.push(`${d.path}: ${d.old} → ${d.new} (within ±${HP_TOLERANCE} HP tolerance — unrounded intermediate math, expected)`);
    } else {
      hardProblems.push(`${d.path}: old=${JSON.stringify(d.old)} new=${JSON.stringify(d.new)}`);
    }
  }

  if (hardProblems.length > 0) {
    allOk = false;
    console.log(`\n✖ MISMATCH: ${scenario.name}`);
    for (const p of hardProblems) console.log(`    ${p}`);
  } else if (softProblems.length > 0) {
    console.log(`\n~ ${scenario.name}: matches within tolerance (${softProblems.length} hp field(s) shifted by <${HP_TOLERANCE}, no other divergence)`);
    for (const p of softProblems) console.log(`    ${p}`);
  } else {
    console.log(`✔ ${scenario.name}: exact match`);
  }
}

console.log(allOk
  ? '\nALL SCENARIOS MATCH (exactly, or within the documented sub-HP-point rounding tolerance) — safe to regenerate fixtures.'
  : '\nHARD MISMATCHES FOUND — do NOT regenerate fixtures. Investigate the divergence above first.');
process.exit(allOk ? 0 : 1);
