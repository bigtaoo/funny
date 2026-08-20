#!/usr/bin/env node
// Shared reading logic for the two coverage scripts run from the repo root after all
// client/server `test:coverage` steps: coverageSummary.mjs (pure report, never fails) and
// checkCoverageThreshold.mjs (CI gate, fails the job below the threshold). Kept in one place so
// the package lists and the two coverage-backend parsers can't drift between the two scripts —
// see claudedocs/server.md "测试覆盖率百分比工具" for why two backends exist.
import { readFileSync, readdirSync } from 'node:fs';
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
];

// Workspaces whose `npm run test:coverage` writes coverage/lcov.info instead (Node's built-in
// test coverage — see server/engine/scripts/runTests.mjs).
export const LCOV_PACKAGES = ['server/engine'];

// ADR-070 (2026-08-20): the tool packages still on the ratchet — four of the original five, since
// Phase 4a graduated tools/map-editor into the gated list above. They emit the same
// coverage-summary.json as that list, and they appear in the report the same way — but they are NOT
// gated on the 90% line bar yet, because each one's scope needs structural work first (see each
// tools/*/vitest.config.ts and claudedocs/tools-testing.md for the per-tool exit condition). What
// IS gated for them from day one is that the output exists at all: a tool package that stops
// producing coverage/ fails checkCoverageThreshold.mjs exactly like a server workspace would. The
// percentage is on a ratchet; the plumbing is not.
// Graduating one of these (Phase 4a did, for tools/map-editor) means MOVING its line up into
// JSON_SUMMARY_PACKAGES, not copying it: a package listed in both would get two rows out of
// collectRows(), and the gate would be satisfied by the exempt one while the table read as green.
// coverageScripts.test.ts pins that with a duplicate check across all three lists.
export const NOT_GATED_JSON_SUMMARY_PACKAGES = [
  'tools/animator',
  'tools/level-editor',
  'tools/ops',
  'tools/vfx-editor',
];

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
 *  from CI). Row shape: `{ pkg, gated, srcFiles, missing: true }` or `{ pkg, gated, srcFiles,
 *  scopeFiles, lines, statements, branches, functions }` where each metric is
 *  `{ total, covered, pct }`.
 *
 *  `gated: false` (ADR-070) means "report it, don't hold it to the percentage bar yet" — the
 *  threshold script still requires the output to EXIST, it just doesn't compare the number. */
export function collectRows(root) {
  const withMeta = (gated) => (row) => ({ ...row, gated, srcFiles: countSrcFiles(root, row.pkg) });
  return [
    ...JSON_SUMMARY_PACKAGES.map((pkg) => readJsonSummary(root, pkg)).map(withMeta(true)),
    ...LCOV_PACKAGES.map((pkg) => readLcov(root, pkg)).map(withMeta(true)),
    ...NOT_GATED_JSON_SUMMARY_PACKAGES.map((pkg) => readJsonSummary(root, pkg)).map(withMeta(false)),
  ];
}
