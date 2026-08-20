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
