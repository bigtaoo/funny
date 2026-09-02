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
// Gates on LINE coverage only (not branches/functions) — matches this repo's own convention
// throughout claudedocs' "补测" writeups and the coverage-baseline memory notes, which have always
// tracked/quoted line % as *the* number; branches/functions are reported for context but were
// never the target metric any "fix the lowest" round chased.
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
// Override the bar with COVERAGE_THRESHOLD=85 (percent) if ever needed — defaults to 90.
import { evaluate, readGateEnv } from './coverageLib.mjs';

const { threshold, testsOk } = readGateEnv();
const ev = evaluate(process.cwd(), { threshold, testsOk });

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
if (ev.missingOutput.length > 0) {
  console.error(
    `checkCoverageThreshold: ${ev.missingOutput.length} package(s) produced no coverage output at all — ` +
      `${ev.missingOutput.map((f) => f.pkg).join(', ')}. That is a broken test/coverage step, not a ` +
      'coverage regression — every package on the list must emit coverage/.',
  );
}
if (ev.failures.length > 0) process.exit(1);

console.log(
  ev.skipped > 0
    ? `checkCoverageThreshold: not enforced — ${ev.measured} gated package(s) >= ${threshold}%, ${ev.skipped} skipped (their test job failed).`
    : `checkCoverageThreshold: OK — all ${ev.measured} gated packages >= ${threshold}%.`,
);
