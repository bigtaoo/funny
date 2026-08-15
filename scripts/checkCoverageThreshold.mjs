#!/usr/bin/env node
// CI gate (2026-08-15): fails the job if any tracked package's LINE coverage is below the
// threshold. Runs alongside coverageSummary.mjs (same coverage/ artifacts, same package lists —
// see coverageLib.mjs) in the `coverage-report` job, which only runs on the pre-CD pass (push to
// main / manual dispatch) per claudedocs/server.md's "PR 上一律跑无 coverage 的 npm test" note —
// so this script only ever runs when every package's test:coverage step was actually supposed to
// have produced output. Unlike coverageSummary.mjs (pure report, deliberately never fails), this
// script DOES exit 1, and — because ci.yml's deploy workflows gate on `workflow_run.conclusion ==
// 'success'` — a failure here blocks every `*-deploy.yml` from firing, i.e. this is the mechanism
// that turns "90% is our bar" from a read-only report line into an actual release gate.
//
// Gates on LINE coverage only (not branches/functions) — matches this repo's own convention
// throughout claudedocs/server.md's "补测" writeups and the coverage-baseline memory notes, which
// have always tracked/quoted line % as *the* number; branches/functions are reported for context
// but were never the target metric any "fix the lowest" round chased.
//
// A missing coverage/ output (a workspace whose test:coverage step didn't run or didn't finish)
// fails closed, not open — we can't confirm >=90% without the data, so silently passing would
// let a broken pipeline masquerade as "coverage is fine" (see claudedocs/worktrees.md's "假绿"
// precedent for why this repo treats silent skips as bugs, not passes).
//
// Usage: node scripts/checkCoverageThreshold.mjs   (cwd = repo root; same as coverageSummary.mjs)
// Override the bar with COVERAGE_THRESHOLD=85 (percent) if ever needed — defaults to 90.
import { appendFileSync } from 'node:fs';
import { collectRows } from './coverageLib.mjs';

const THRESHOLD = Number(process.env.COVERAGE_THRESHOLD ?? 90);
const ROOT = process.cwd();
const rows = collectRows(ROOT);

const results = rows.map((row) => {
  if (row.missing) return { pkg: row.pkg, ok: false, reason: 'no coverage/ output found' };
  const pct = row.lines.pct;
  return { pkg: row.pkg, ok: pct >= THRESHOLD, pct };
});

const failures = results.filter((r) => !r.ok);

const lines = [];
lines.push(`## Coverage threshold check (>= ${THRESHOLD}% lines per package)`);
lines.push('');
lines.push('| Package | Lines | Status |');
lines.push('|---|---|---|');
for (const r of results) {
  const pctStr = r.pct === undefined ? '—' : `${r.pct.toFixed(1)}%`;
  const status = r.ok ? '✅' : `❌ ${r.reason ?? `below ${THRESHOLD}%`}`;
  lines.push(`| ${r.pkg} | ${pctStr} | ${status} |`);
}
lines.push('');

if (failures.length > 0) {
  lines.push(`**FAILED** — ${failures.length} package(s) below the ${THRESHOLD}% line-coverage bar: ${failures.map((f) => f.pkg).join(', ')}.`);
} else {
  lines.push(`**PASSED** — all ${results.length} packages are at or above ${THRESHOLD}% line coverage.`);
}
lines.push('');

const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
}

if (failures.length > 0) {
  console.error(`checkCoverageThreshold: ${failures.length} package(s) below ${THRESHOLD}%: ${failures.map((f) => `${f.pkg} (${f.reason ?? f.pct.toFixed(1) + '%'})`).join(', ')}`);
  process.exit(1);
}
console.log(`checkCoverageThreshold: OK — all ${results.length} packages >= ${THRESHOLD}%.`);
