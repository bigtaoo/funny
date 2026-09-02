#!/usr/bin/env node
// Shared reading logic for the two coverage scripts run from the repo root after all
// client/server `test:coverage` steps: coverageSummary.mjs (pure report, never fails) and
// checkCoverageThreshold.mjs (CI gate, fails the job below the threshold). Kept in one place so
// the package lists and the two coverage-backend parsers can't drift between the two scripts —
// see claudedocs/server.md "测试覆盖率百分比工具" for why two backends exist.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Workspaces whose `npm run test:coverage` writes coverage/coverage-summary.json (vitest,
// provider 'v8', reporter 'json-summary').
export const JSON_SUMMARY_PACKAGES = [
  'client',
  'server/shared',
  'server/admin',
  'server/analyticsvc',
  'server/auctionsvc',
  'server/botsvc',
  'server/commercial',
  'server/gameserver',
  'server/gateway',
  'server/matchsvc',
  'server/metaserver',
  'server/socialsvc',
  'server/worldsvc',
  // ADR-070 Phase 4a (2026-08-20): the first tools/ package to graduate off the not-gated list
  // below. Its coverage.include is now directory-level only (src/state/**, src/tiles/**, plus two
  // whole top-level files) after the pure iso-projection/tile-styling pair moved out of the PIXI
  // half of src/render/ into src/tiles/ — the per-file include entries that used to be needed
  // were the missing module boundary, and were the stated exit condition for this package.
  'tools/map-editor',
  // ADR-070 Phase 4b (2026-08-20, same day): second to graduate. Its include had been the
  // narrowest of the five tools (src/state/** + units.ts, 216 of ~1670 lines) because the pure
  // coordinate/hit-test math, though exported since Phase 4 (2026-08-13), still lived inside the
  // canvas-owning BoardPanel/TimelinePanel classes. It now lives in src/layout/{board,timeline}.ts
  // and the include is directory-level (src/state/**, src/layout/**, src/units.ts) — 445/445 lines.
  'tools/level-editor',
  // ADR-070 Phase 4c (2026-08-20, same day): third to graduate. The gap here was never
  // structural — io/IOController.ts sat at 0% inside an already-gated scope with no browser
  // dependency in its way, so it was a missing test file rather than a missing harness; it is
  // now 100%, and the package's whole gated scope is 529/529 lines. The include also lost its
  // last per-file entry: rendering/Playback.ts turned out to be editor state (no PIXI, no
  // canvas, no DOM) and moved to src/model/Playback.ts, leaving src/rendering/ homogeneously the
  // PIXI half and the include at two directories (src/model/**, src/io/**).
  'tools/vfx-editor',
  // ADR-070 Phase 4d (2026-08-20, same day): fourth to graduate, and the only one of the five
  // whose exit condition was pure test-writing with no move at all — its include has been
  // directory-level (src/core/**, src/skeleton/**, src/animation/**, src/io/**) since ADR-070
  // landed, and printed 64.3% because it deliberately kept its untested IndexedDB layer inside
  // the scope. Now 98.9% (1426/1442). NOTE this package has by far the largest gate headroom of
  // the five (~140 lines at that coverage, vs 72 for map-editor and 49 for level-editor), so
  // `tools/animator/test/pureLayerBoundary.test.ts` — not the percentage — is what keeps a
  // PIXI/DOM file out of those four directories.
  'tools/animator',
  // ADR-070 Phase 4e (2026-08-20, same day): the last of the five, and the only one that had NO
  // include list at all — it reported its whole self at 8.84% (322/3639) on purpose, because the
  // nine pure helpers it had exported each still lived inside a pages/*.ts file that was 90%
  // h()-built DOM, so there was no directory to point at and no honest way to scope it without
  // first building the layer. Every page now has a src/logic/<page>.ts (its queries, validation,
  // pivots, permission decisions and derived labels) with pages/* as DOM assembly, and src/api.ts
  // moved to src/api/index.ts so the endpoint surface and its transport share one directory. The
  // include is ['src/logic/**', 'src/api/**'] — 1516/1516 lines. Its two directories are held to
  // DIFFERENT purity rules by tools/ops/test/pureLayerBoundary.test.ts (logic/ may touch no global
  // at all; api/ may use fetch/localStorage/location and no DOM), because a REST client that were
  // forbidden the network would just be untestable by fiat.
  'tools/ops',
];

// Workspaces whose `npm run test:coverage` writes coverage/lcov.info instead (Node's built-in
// test coverage — see server/engine/scripts/runTests.mjs).
export const LCOV_PACKAGES = ['server/engine'];

// There used to be a third list here — `NOT_GATED_JSON_SUMMARY_PACKAGES`, ADR-070's "reported, not
// gated" ratchet: packages that had to EMIT coverage but were not yet held to the 90% percentage,
// so the five tools/ packages could be measured from day one while their scopes were restructured
// one at a time. Phase 4a–4e emptied it (map-editor, level-editor, vfx-editor, animator, ops) and
// Phase 4e retired the mechanism with it, on the reasoning recorded in ADR-070's closing entry: the
// exemption was a bounded transition device, and leaving a working way to be exempt from the gate in
// place is a standing invitation to reach for it instead of doing the structural work — which is the
// one thing ADR-070 decided against. Re-adding it is a ~40-line change and is in the history.
//
// What that transition left behind and is NOT part of the ratchet, so it stays: the `Scope (files)`
// column (so a shrunken `coverage.include` is visible next to the percentage it flatters), and the
// gate's split between "below the bar" and "produced no coverage at all" — two different failures
// that used to print as one wrong message.

export function readJsonSummary(root, pkg) {
  try {
    const raw = readFileSync(join(root, pkg, 'coverage', 'coverage-summary.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const { total } = parsed;
    return {
      pkg,
      lines: total.lines,
      statements: total.statements,
      branches: total.branches,
      functions: total.functions,
      // Every key except `total` is one measured file, so this is the size of the package's
      // coverage scope — see countSrcFiles below for why that is worth printing.
      scopeFiles: Object.keys(parsed).filter((k) => k !== 'total').length,
    };
  } catch {
    return { pkg, missing: true };
  }
}

/** Counts the .ts/.tsx source files under `<pkg>/src` (no .d.ts, no test files/dirs) — the
 *  denominator for the report's "scope" column.
 *
 *  Why this column exists (ADR-070): a package's coverage percentage is measured over whatever
 *  its `coverage.include` selects, and several packages here deliberately select less than their
 *  whole tree — client scopes to src/game/**, the four scoped tool packages to their pure logic
 *  layers. That is a legitimate, documented choice, but it is also the one knob that can raise a
 *  percentage without adding a single test. Printing "measured N of M source files" next to the
 *  percentage makes any narrowing show up in the same table as the number it flatters, so the
 *  trade is visible at review time instead of buried in a vitest config. */
export function countSrcFiles(root, pkg) {
  const TEST_DIRS = new Set(['test', 'tests', '__tests__']);
  const walk = (dir) => {
    let n = 0;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!TEST_DIRS.has(e.name) && e.name !== 'node_modules') n += walk(join(dir, e.name));
      } else if (e.isFile()) {
        if (!/\.tsx?$/.test(e.name)) continue;
        if (e.name.endsWith('.d.ts') || /\.test\.tsx?$/.test(e.name)) continue;
        n++;
      }
    }
    return n;
  };
  return walk(join(root, pkg, 'src'));
}

// Sums LF/LH (lines found/hit), BRF/BRH (branches), FNF/FNH (functions) across every SF: block
// in an lcov file. lcov has no per-file "statements" concept distinct from lines, so statements
// mirrors lines here (matches what most lcov-based tools report).
export function readLcov(root, pkg) {
  try {
    const raw = readFileSync(join(root, pkg, 'coverage', 'lcov.info'), 'utf8');
    const totals = { lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
    let scopeFiles = 0;
    for (const line of raw.split('\n')) {
      const [key, value] = line.split(':');
      if (key === 'SF') scopeFiles++;
      else if (key === 'LF') totals.lf += Number(value);
      else if (key === 'LH') totals.lh += Number(value);
      else if (key === 'BRF') totals.brf += Number(value);
      else if (key === 'BRH') totals.brh += Number(value);
      else if (key === 'FNF') totals.fnf += Number(value);
      else if (key === 'FNH') totals.fnh += Number(value);
    }
    const pct = (covered, total) => (total === 0 ? 100 : (covered / total) * 100);
    return {
      pkg,
      lines: { total: totals.lf, covered: totals.lh, pct: pct(totals.lh, totals.lf) },
      statements: { total: totals.lf, covered: totals.lh, pct: pct(totals.lh, totals.lf) },
      branches: { total: totals.brf, covered: totals.brh, pct: pct(totals.brh, totals.brf) },
      functions: { total: totals.fnf, covered: totals.fnh, pct: pct(totals.fnh, totals.fnf) },
      scopeFiles,
    };
  } catch {
    return { pkg, missing: true };
  }
}

/** Reads every tracked package's coverage output (root = repo root, i.e. process.cwd() when run
 *  from CI). Row shape: `{ pkg, srcFiles, missing: true }` or `{ pkg, srcFiles, scopeFiles, lines,
 *  statements, branches, functions }` where each metric is `{ total, covered, pct }`.
 *
 *  Every row is gated. Rows used to carry a `gated` boolean for ADR-070's ratchet; that field went
 *  away with the third list above — see its note for why, and coverageScripts.test.ts's
 *  "every row is gated, and the not-gated pipeline is gone" case for the assertion that keeps it
 *  away. */
export function collectRows(root) {
  const withMeta = (row) => ({ ...row, srcFiles: countSrcFiles(root, row.pkg) });
  return [
    ...JSON_SUMMARY_PACKAGES.map((pkg) => readJsonSummary(root, pkg)).map(withMeta),
    ...LCOV_PACKAGES.map((pkg) => readLcov(root, pkg)).map(withMeta),
  ];
}

// ─── Gate evaluation ─────────────────────────────────────────────────────────────────────────────
//
// 2026-09-02: `evaluate` lives here, down with the parsers, for the same reason the package
// lists do — the run-summary page used to carry TWO headings and TWO 19-row tables
// (coverageSummary's report and checkCoverageThreshold's gate table) whose `Lines` columns were
// byte-identical and whose `Status` column was 19 identical ✅ on every green run. Merging them
// into one section means exactly one script may RENDER it (see scripts/coverageReport.mjs),
// while the other still has to know the same verdict to print it in its own log and pick its
// exit code — so the verdict is decided here, once, instead of being derived twice from the same
// rows with two chances to disagree.

export const DEFAULT_THRESHOLD = 90;

/** Reads the two knobs CI passes in, so both scripts read them identically.
 *
 *  TESTS_OK unset (local runs) is treated as 'true' — fail closed, same as before it existed. */
export function readGateEnv(env = process.env) {
  return {
    threshold: Number(env.COVERAGE_THRESHOLD ?? DEFAULT_THRESHOLD),
    testsOk: (env.TESTS_OK ?? 'true') !== 'false',
  };
}

/** How many currently-covered lines this package could lose before it breaches the bar — negative
 *  if it already has.
 *
 *  This is the column that makes the table worth reading. Sorted by percentage alone, 90.7% over
 *  8670 lines (65 lines of slack) and 92.1% over 924 lines (19 lines of slack) sort the wrong way
 *  round, and both read as "93%, fine" beside a 100.0% with hundreds to spare. It also answers the
 *  question people actually arrive with — "how much untested code can I add here before CI stops
 *  me" — which the percentage on its own never could. */
export function gateHeadroom(row, threshold) {
  if (row.missing) return null;
  return row.lines.covered - Math.ceil((threshold / 100) * row.lines.total);
}

/** Line-weighted totals across every measured row, per metric. */
function overallOf(rows) {
  const acc = { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
  for (const row of rows) {
    if (row.missing) continue;
    for (const key of Object.keys(acc)) {
      acc[key][0] += row[key].covered;
      acc[key][1] += row[key].total;
    }
  }
  const pct = (k) => (acc[k][1] === 0 ? 0 : (acc[k][0] / acc[k][1]) * 100);
  return { lines: pct('lines'), branches: pct('branches'), functions: pct('functions') };
}

/**
 * The whole gate decision in one object: which packages pass, which of the two ways the others
 * failed, the weighted overall, and one `verdict` of 'pass' | 'fail' | 'not-enforced' | 'empty'.
 *
 * The two failure kinds stay separate all the way through (`belowBar` vs `missingOutput`), because
 * "produced no coverage at all" is a broken pipeline and not a coverage regression — reporting it
 * as the latter sent readers hunting for missing tests when the fix was a missing CI step.
 *
 * 'empty' is the canary: every check below iterates `rows`, so an empty list would otherwise print
 * a cheerful "all 0 packages >= 90%" and exit 0 — a gate that retires itself by turning green.
 */
export function evaluate(root, { threshold = DEFAULT_THRESHOLD, testsOk = true } = {}) {
  const rows = collectRows(root);
  const results = rows.map((row) => {
    if (row.missing) {
      // Missing coverage/ output fails closed when the tests passed — we cannot confirm >=T%
      // without the data. When a test job already failed, the absence is a CONSEQUENCE of that
      // failure, the run is already red and no deploy can fire, so this gate has nothing left to
      // protect: report it and pass.
      return testsOk
        ? { pkg: row.pkg, row, ok: false, reason: 'no coverage/ output found' }
        : { pkg: row.pkg, row, ok: true, reason: 'not evaluated — its test job failed' };
    }
    const pct = row.lines.pct;
    return { pkg: row.pkg, row, ok: pct >= threshold, pct, headroom: gateHeadroom(row, threshold) };
  });

  const failures = results.filter((r) => !r.ok);
  const belowBar = failures.filter((f) => !f.reason);
  const missingOutput = failures.filter((f) => f.reason);
  // `measured` counts rows that actually produced a number, NOT "everything we didn't skip" —
  // those are different whenever a package is missing its coverage/ while the tests passed, and
  // the old arithmetic made the heading claim "19/19 measured" on a run where one shard emitted
  // nothing at all. `skipped` stays narrower: only rows excused because their test job failed.
  const skipped = results.filter((r) => r.ok && r.reason).length;
  const measured = results.filter((r) => !r.row.missing).length;

  const verdict =
    rows.length === 0
      ? 'empty'
      : failures.length > 0
        ? 'fail'
        : skipped > 0
          ? 'not-enforced'
          : 'pass';

  return {
    threshold,
    testsOk,
    rows,
    results,
    failures,
    belowBar,
    missingOutput,
    skipped,
    measured,
    verdict,
    overall: overallOf(rows),
  };
}

// ─── Baseline (the previous run's numbers, for the Δ column) ─────────────────────────────────────
//
// The one thing a reader of a GREEN run actually needs to know is whether the number moved, and
// the table could not answer it: 19 absolute percentages, most in the low 90s, tell you nothing
// about whether the PR in front of you just cost a point. ci.yml carries this file between runs
// via actions/cache — saved only on a green push to `main`, restored on every run — so every run,
// PRs included, is compared against the last `main` that passed the gate.
//
// An absent or unreadable baseline is not an error: Δ renders '—' and nothing else changes. That
// is the state on the first run after this landed, after a cache eviction, and on every local
// invocation, so it has to be the boring path rather than a failure.

export function writeBaseline(path, evaluation, meta = {}) {
  const rows = {};
  for (const row of evaluation.rows) {
    if (row.missing) continue;
    rows[row.pkg] = {
      lines: row.lines.pct,
      branches: row.branches.pct,
      functions: row.functions.pct,
      scopeFiles: row.scopeFiles,
      srcFiles: row.srcFiles,
    };
  }
  const body = { ...meta, overall: evaluation.overall, rows };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

export function readBaseline(path) {
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed.rows === 'object' && parsed.rows !== null ? parsed : null;
  } catch {
    return null;
  }
}
