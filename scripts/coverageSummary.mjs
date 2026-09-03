#!/usr/bin/env node
// CI's coverage REPORT step: reads the coverage output every client/server/tools workspace's own
// `test:coverage` script just produced and renders the run-summary section — run from the repo
// root, after all test steps. Pure reporting: never fails the job (always exits 0), so a missing
// or partial coverage file (a workspace whose tests didn't run this time) just shows as a "—" row
// instead of red-Xing an otherwise-green CI run over a report step. The exit code lives separately
// in checkCoverageThreshold.mjs; the verdict comes from coverageLib.mjs's `evaluate` (which the
// gate reads too, so the two cannot disagree) and the markdown from coverageReport.mjs.
//
// Two coverage backends are in play behind that (see claudedocs/client-testing.md and
// claudedocs/server-testing-tooling.md "测试覆盖率"):
//   - vitest workspaces (client + tools/* + all server/* except engine) emit
//     coverage/coverage-summary.json (the `json-summary` reporter) — a ready-made istanbul-style
//     `{ total: { lines, statements, branches, functions } }` object, no parsing needed.
//   - server/engine runs its compiled dist/ output through Node's own `node --test
//     --experimental-test-coverage`, which only writes lcov (coverage/lcov.info) — summed by hand
//     in coverageLib's readLcov from its LF/LH/BRF/BRH/FNF/FNH lines.
//
// 2026-09-02 — THIS script is now the only one that writes to $GITHUB_STEP_SUMMARY. It used to
// write a `## Test coverage` table and then checkCoverageThreshold.mjs appended a second
// `## Coverage threshold check` heading with a second 19-row table whose `Lines` column was
// byte-identical to this one's and whose `Status` column was 19 identical ✅ on any green run: ~40
// rows of page to convey one bit, with the actual verdict at the bottom of the second one. The
// section is now one verdict-carrying heading, failures/regressions above the fold, and the table
// inside a `<details>`. See renderSection in coverageReport.mjs for the rest of what changed
// (Statements column dropped, Headroom and Δ added, rows sorted most-fragile first).
//
// Usage: node scripts/coverageSummary.mjs   (cwd = repo root)
//   COVERAGE_THRESHOLD=85         override the bar the section reports against (default 90)
//   TESTS_OK=false                a test job in this run already failed (see coverageLib)
//   COVERAGE_BASELINE_IN=<path>   previous run's baseline JSON, for the Δ column
//   COVERAGE_BASELINE_OUT=<path>  write this run's numbers out as the next baseline
// IN and OUT may be the same file (ci.yml passes one path for both): the baseline is read on the
// line below, and only written at the bottom, after the section has already been rendered.
import { appendFileSync } from 'node:fs';
import { evaluate, readBaseline, readGateEnv, writeBaseline } from './coverageLib.mjs';
import { renderSection } from './coverageReport.mjs';

const ROOT = process.cwd();
const ev = evaluate(ROOT, readGateEnv());
const report = renderSection(ev, readBaseline(process.env.COVERAGE_BASELINE_IN));

console.log(report);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}

// Written unconditionally when asked for; ci.yml decides whether it becomes the next baseline (it
// only saves the cache entry on a green push to main), so a red run cannot poison the comparison
// every later run is read against.
if (process.env.COVERAGE_BASELINE_OUT) {
  writeBaseline(process.env.COVERAGE_BASELINE_OUT, ev, {
    commit: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
  });
}
