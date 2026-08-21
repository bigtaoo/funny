#!/usr/bin/env node
// CI gate (2026-08-15): fails the job if any tracked package's LINE coverage is below the
// threshold. Runs alongside coverageSummary.mjs (same coverage/ artifacts, same package lists —
// see coverageLib.mjs) in the `coverage-report` job. Since the same-day CI-stability pass it runs
// on PRs as well as on the pre-CD push: every event now runs `test:coverage`, so a coverage
// regression is caught by the PR that causes it instead of by the merge that ships it.
// Unlike coverageSummary.mjs (pure report, deliberately never fails), this
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
// ADR-070 (2026-08-20) briefly added a second class of row — `gated: false`: reported, required to
// PRODUCE coverage, not yet held to the percentage — so the five tools/* packages could be measured
// while their scopes were restructured. Phase 4e emptied and retired it the same day (see
// coverageLib.mjs). One thing that pass left behind and is kept below: the two failure kinds are
// reported as two separate messages, because "produced no coverage at all" is a broken pipeline and
// not a coverage regression, and printing it as the latter sent readers hunting for missing tests
// when the fix was a missing CI step.
//
// Usage: node scripts/checkCoverageThreshold.mjs   (cwd = repo root; same as coverageSummary.mjs)
// Override the bar with COVERAGE_THRESHOLD=85 (percent) if ever needed — defaults to 90.
import { appendFileSync } from 'node:fs';
import { collectRows } from './coverageLib.mjs';

const THRESHOLD = Number(process.env.COVERAGE_THRESHOLD ?? 90);
const ROOT = process.cwd();
const rows = collectRows(ROOT);

// ci.yml sets TESTS_OK=false when any test job in this run failed. In that case a package with no
// coverage/ output is a CONSEQUENCE of that failure (the shard died before writing it), not
// independent evidence of a broken pipeline — reporting it as a second failure buries the real
// cause under a louder, wronger one (run 31887181835: "no coverage/ output found for
// server/metaserver", actual cause: one flaky e2e case in the metaserver shard). The run is already
// red and no *-deploy.yml can fire, so this gate has nothing left to protect: report and exit 0.
// Unset (local runs) is treated as 'true' — fail closed, same as before.
const TESTS_OK = (process.env.TESTS_OK ?? 'true') !== 'false';

// Canary, same reasoning as scripts/checkFileLength.mjs' and checkDocLinks': every check below
// iterates `rows`, so an empty list would print a cheerful "all 0 packages >= 90%" and exit 0 —
// a gate that retires itself by turning green. An emptied package list in coverageLib.mjs, or a
// bad `root`, must fail loudly instead.
if (rows.length === 0) {
  console.error(
    'checkCoverageThreshold: FAILED — 0 packages to check. Every assertion here iterates that ' +
      'list, so this run verified nothing (coverageLib.mjs\'s package lists are empty, or this was ' +
      'not run from the repo root).',
  );
  process.exit(1);
}

const results = rows.map((row) => {
  if (row.missing) {
    return TESTS_OK
      ? { pkg: row.pkg, ok: false, reason: 'no coverage/ output found' }
      : { pkg: row.pkg, ok: true, reason: 'not evaluated — its test job failed' };
  }
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
  const status = r.ok
    ? r.reason
      ? `⏭️ ${r.reason}`
      : '✅'
    : `❌ ${r.reason ?? `below ${THRESHOLD}%`}`;
  lines.push(`| ${r.pkg} | ${pctStr} | ${status} |`);
}
lines.push('');
if (!TESTS_OK) {
  lines.push('_A test job in this run failed, so packages without coverage output are skipped rather than reported as gate failures — the run is already red. Fix the failing tests; this gate re-arms on the next run._');
  lines.push('');
}

const skipped = results.filter((r) => r.ok && r.reason).length;
const measured = results.length - skipped;
// The two failure kinds are reported separately: "no coverage/ output" is a broken pipeline, not a
// coverage regression. Lumping them together sent readers looking for missing tests when the actual
// fix is a missing CI step.
const missingOutput = failures.filter((f) => f.reason);
const belowBar = failures.filter((f) => !f.reason);
if (failures.length > 0) {
  if (belowBar.length > 0) {
    lines.push(`**FAILED** — ${belowBar.length} package(s) below the ${THRESHOLD}% line-coverage bar: ${belowBar.map((f) => `${f.pkg} (${f.pct.toFixed(1)}%)`).join(', ')}.`);
  }
  if (missingOutput.length > 0) {
    lines.push(`**FAILED** — ${missingOutput.length} package(s) produced no coverage output at all: ${missingOutput.map((f) => f.pkg).join(', ')}. That is a broken test/coverage step, not a coverage regression — every package on the list must emit coverage/.`);
  }
} else if (skipped > 0) {
  lines.push(`**NOT ENFORCED** — ${measured} gated package(s) measured and at or above ${THRESHOLD}%, ${skipped} skipped because their test job failed.`);
} else {
  lines.push(`**PASSED** — all ${measured} gated packages are at or above ${THRESHOLD}% line coverage.`);
}
lines.push('');

const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
}

if (failures.length > 0) {
  console.error(`checkCoverageThreshold: ${failures.length} package(s) failed — ${failures.map((f) => `${f.pkg} (${f.reason ?? 'below ' + THRESHOLD + '%, at ' + f.pct.toFixed(1) + '%'})`).join(', ')}`);
  process.exit(1);
}
console.log(
  skipped > 0
    ? `checkCoverageThreshold: not enforced — ${measured} gated package(s) >= ${THRESHOLD}%, ${skipped} skipped (their test job failed).`
    : `checkCoverageThreshold: OK — all ${measured} gated packages >= ${THRESHOLD}%.`,
);
