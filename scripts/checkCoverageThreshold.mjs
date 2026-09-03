#!/usr/bin/env node
// CI GATE (2026-08-15): fails the job if any tracked package's LINE coverage is below the
// threshold. Runs in the `coverage-report` job right after coverageSummary.mjs, over the same
// coverage/ artifacts and the same package lists (see coverageLib.mjs). Since the same-day
// CI-stability pass it runs on PRs as well as on the pre-CD push: every event now runs
// `test:coverage`, so a coverage regression is caught by the PR that causes it instead of by the
// merge that ships it. Unlike coverageSummary.mjs (pure report, deliberately never fails), this
// script DOES exit 1, and — because ci.yml's deploy workflows gate on `workflow_run.conclusion ==
// 'success'` — a failure here blocks every `*-deploy.yml` from firing, i.e. this is the mechanism
// that turns "90% is our bar" from a read-only report line into an actual release gate.
//
// Gates on LINE and BRANCH coverage, each against its own 90% bar (functions stays reported-only).
//
// 2026-09-03 — the branch bar is new, and the reason it is here is that its absence was invisible.
// For a year this gated lines only, matching the repo convention that every "补测" writeup and
// coverage-baseline note quotes line % as *the* number. Measuring the column nobody gated found
// every package >=90% on lines and 7 of the 13 server packages under 90% on branches, one of them
// (server/admin) at 93.81% lines / 82.09% branches. That is not a rounding difference: uncovered
// branches concentrate in the absent-field fallbacks, the refusal paths and the lost-CAS-race arms
// — the code that only runs when something has gone wrong, which is the code a test is most worth
// having for. Functions is deliberately still ungated: it is the metric most easily satisfied by
// calling a function once and asserting nothing.
//
// A package below both bars is reported once per bar, on its own line, because "add tests for the
// untested lines" and "exercise the other side of the conditions you already run" are different
// pieces of work.
//
// A missing coverage/ output (a workspace whose test:coverage step didn't run or didn't finish)
// fails closed, not open — we can't confirm >=90% without the data, so silently passing would let
// a broken pipeline masquerade as "coverage is fine" (see claudedocs/worktrees.md's "假绿"
// precedent for why this repo treats silent skips as bugs, not passes). The exception is TESTS_OK:
// when ci.yml reports that a test job in this run already failed, a package with no coverage/ is a
// CONSEQUENCE of that failure, the run is already red, no deploy can fire, and reporting it as a
// second, louder failure buries the real cause (run 31887181835: "no coverage/ output found for
// server/metaserver", actual cause: one flaky e2e case in the metaserver shard). Both rules, and
// the split between the two failure kinds, now live in coverageLib.mjs's `evaluate`.
//
// 2026-09-02 — this script no longer writes to $GITHUB_STEP_SUMMARY. It used to append a second
// heading and a second full table under coverageSummary.mjs's, duplicating that table's `Lines`
// column verbatim and adding a `Status` column that was N identical ✅ on every green run. The
// summary page section is coverageSummary.mjs's job now and already carries this verdict in its
// heading (both scripts get it from the same `evaluate` call, so they cannot disagree); what stays
// here is the STEP's own log output and — the only thing that was ever unique to this file — the
// exit code.
//
// Usage: node scripts/checkCoverageThreshold.mjs   (cwd = repo root; same as coverageSummary.mjs)
// Override either bar if ever needed — both default to 90:
//   COVERAGE_THRESHOLD=85            the line bar
//   COVERAGE_BRANCH_THRESHOLD=80     the branch bar
// One global knob per bar, not a per-package exemption list — see readGateEnv's note for why.
import { evaluate, readGateEnv } from './coverageLib.mjs';

const { threshold, branchThreshold, testsOk } = readGateEnv();
const ev = evaluate(process.cwd(), { threshold, branchThreshold, testsOk });

// Canary, same reasoning as scripts/checkFileLength.mjs' and checkDocLinks': every check in
// `evaluate` iterates the package list, so an empty one would print a cheerful "all 0 packages >=
// 90%" and exit 0 — a gate that retires itself by turning green. An emptied package list in
// coverageLib.mjs, or a bad cwd, must fail loudly instead.
if (ev.verdict === 'empty') {
  console.error(
    'checkCoverageThreshold: FAILED — 0 packages to check. Every assertion here iterates that ' +
      'list, so this run verified nothing (coverageLib.mjs\'s package lists are empty, or this was ' +
      'not run from the repo root).',
  );
  process.exit(1);
}

// One line per failing package, so the step's own log says what broke without anyone opening the
// summary page. The two kinds stay apart here too: "produced no coverage output at all" is a
// broken test/coverage step, not a coverage regression, and lumping them together sent readers
// looking for missing tests when the fix was a missing CI step.
if (ev.belowBar.length > 0) {
  console.error(
    `checkCoverageThreshold: ${ev.belowBar.length} package(s) below the ${threshold}% line-coverage bar — ` +
      ev.belowBar.map((f) => `${f.pkg} (${f.pct.toFixed(1)}%, ${f.headroom} lines)`).join(', '),
  );
}
if (ev.belowBranchBar.length > 0) {
  console.error(
    `checkCoverageThreshold: ${ev.belowBranchBar.length} package(s) below the ${branchThreshold}% branch-coverage bar — ` +
      ev.belowBranchBar
        .map((f) => `${f.pkg} (${f.branchPct.toFixed(1)}%, ${f.branchHeadroom} branches)`)
        .join(', '),
  );
}
if (ev.missingOutput.length > 0) {
  console.error(
    `checkCoverageThreshold: ${ev.missingOutput.length} package(s) produced no coverage output at all — ` +
      `${ev.missingOutput.map((f) => f.pkg).join(', ')}. That is a broken test/coverage step, not a ` +
      'coverage regression — every package on the list must emit coverage/.',
  );
}
if (ev.failures.length > 0) process.exit(1);

const bars = `>= ${threshold}% lines / ${branchThreshold}% branches`;
console.log(
  ev.skipped > 0
    ? `checkCoverageThreshold: not enforced — ${ev.measured} gated package(s) ${bars}, ${ev.skipped} skipped (their test job failed).`
    : `checkCoverageThreshold: OK — all ${ev.measured} gated packages ${bars}.`,
);
