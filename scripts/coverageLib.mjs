#!/usr/bin/env node
// Shared reading logic for the two coverage scripts run from the repo root after all
// client/server `test:coverage` steps: coverageSummary.mjs (pure report, never fails) and
// checkCoverageThreshold.mjs (CI gate, fails the job below the threshold). Kept in one place so
// the package lists and the two coverage-backend parsers can't drift between the two scripts —
// see claudedocs/server.md "测试覆盖率百分比工具" for why two backends exist.
import { readFileSync } from 'node:fs';
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
];

// Workspaces whose `npm run test:coverage` writes coverage/lcov.info instead (Node's built-in
// test coverage — see server/engine/scripts/runTests.mjs).
export const LCOV_PACKAGES = ['server/engine'];

export function readJsonSummary(root, pkg) {
  try {
    const raw = readFileSync(join(root, pkg, 'coverage', 'coverage-summary.json'), 'utf8');
    const { total } = JSON.parse(raw);
    return {
      pkg,
      lines: total.lines,
      statements: total.statements,
      branches: total.branches,
      functions: total.functions,
    };
  } catch {
    return { pkg, missing: true };
  }
}

// Sums LF/LH (lines found/hit), BRF/BRH (branches), FNF/FNH (functions) across every SF: block
// in an lcov file. lcov has no per-file "statements" concept distinct from lines, so statements
// mirrors lines here (matches what most lcov-based tools report).
export function readLcov(root, pkg) {
  try {
    const raw = readFileSync(join(root, pkg, 'coverage', 'lcov.info'), 'utf8');
    const totals = { lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
    for (const line of raw.split('\n')) {
      const [key, value] = line.split(':');
      if (key === 'LF') totals.lf += Number(value);
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
    };
  } catch {
    return { pkg, missing: true };
  }
}

/** Reads every tracked package's coverage output (root = repo root, i.e. process.cwd() when run
 *  from CI). Row shape: `{ pkg, missing: true }` or `{ pkg, lines, statements, branches, functions }`
 *  where each metric is `{ total, covered, pct }`. */
export function collectRows(root) {
  return [
    ...JSON_SUMMARY_PACKAGES.map((pkg) => readJsonSummary(root, pkg)),
    ...LCOV_PACKAGES.map((pkg) => readLcov(root, pkg)),
  ];
}
