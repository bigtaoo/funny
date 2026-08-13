#!/usr/bin/env node
// CI's final reporting step: reads the coverage output every client/server workspace's own
// `test:coverage` script just produced and prints one consolidated table — run from the repo
// root, after all test steps. Pure reporting: never fails the job (always exits 0), so a missing
// or partial coverage file (a workspace whose tests didn't run this time) just shows as "—"
// instead of red-Xing an otherwise-green CI run over a report step.
//
// Two report formats coexist because two coverage backends are in play (see claudedocs/
// client-testing.md and claudedocs/server.md "测试覆盖率"):
//   - vitest workspaces (client + all server/* except engine) emit coverage/coverage-summary.json
//     (the `json-summary` reporter) — a ready-made istanbul-style `{ total: { lines, statements,
//     branches, functions } }` object, no parsing needed.
//   - server/engine runs its compiled dist/ output through Node's own `node --test
//     --experimental-test-coverage`, which only writes lcov (coverage/lcov.info) — summed by hand
//     below from its LF/LH/BRF/BRH/FNF/FNH lines.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

// Workspaces whose `npm run test:coverage` writes coverage/coverage-summary.json (vitest,
// provider 'v8', reporter 'json-summary').
const JSON_SUMMARY_PACKAGES = [
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
const LCOV_PACKAGES = ['server/engine'];

function readJsonSummary(pkg) {
  try {
    const raw = readFileSync(join(ROOT, pkg, 'coverage', 'coverage-summary.json'), 'utf8');
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
function readLcov(pkg) {
  try {
    const raw = readFileSync(join(ROOT, pkg, 'coverage', 'lcov.info'), 'utf8');
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

const rows = [
  ...JSON_SUMMARY_PACKAGES.map(readJsonSummary),
  ...LCOV_PACKAGES.map(readLcov),
];

function fmtPct(metric) {
  return metric ? `${metric.pct.toFixed(1)}%` : '—';
}

const overall = { lines: [0, 0], statements: [0, 0], branches: [0, 0], functions: [0, 0] };
for (const row of rows) {
  if (row.missing) continue;
  for (const key of ['lines', 'statements', 'branches', 'functions']) {
    overall[key][0] += row[key].covered;
    overall[key][1] += row[key].total;
  }
}
const overallPct = (key) => (overall[key][1] === 0 ? 0 : (overall[key][0] / overall[key][1]) * 100);

const lines = [];
lines.push('## Test coverage');
lines.push('');
lines.push('| Package | Lines | Statements | Branches | Functions |');
lines.push('|---|---|---|---|---|');
for (const row of rows) {
  if (row.missing) {
    lines.push(`| ${row.pkg} | — | — | — | — |`);
  } else {
    lines.push(`| ${row.pkg} | ${fmtPct(row.lines)} | ${fmtPct(row.statements)} | ${fmtPct(row.branches)} | ${fmtPct(row.functions)} |`);
  }
}
lines.push(`| **Overall** | **${overallPct('lines').toFixed(1)}%** | **${overallPct('statements').toFixed(1)}%** | **${overallPct('branches').toFixed(1)}%** | **${overallPct('functions').toFixed(1)}%** |`);
lines.push('');

const missing = rows.filter((r) => r.missing).map((r) => r.pkg);
if (missing.length > 0) {
  lines.push(`_No coverage/ output found for: ${missing.join(', ')} — its test:coverage step may not have run._`);
  lines.push('');
}

const report = lines.join('\n');
console.log(report);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
}
