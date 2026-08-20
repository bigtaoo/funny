#!/usr/bin/env node
// CI's final reporting step: reads the coverage output every client/server workspace's own
// `test:coverage` script just produced and prints one consolidated table — run from the repo
// root, after all test steps. Pure reporting: never fails the job (always exits 0), so a missing
// or partial coverage file (a workspace whose tests didn't run this time) just shows as "—"
// instead of red-Xing an otherwise-green CI run over a report step. The threshold gate lives
// separately in checkCoverageThreshold.mjs (see coverageLib.mjs for the shared package lists/parsers
// both scripts use — this file used to inline them, kept in sync by hand, until that script needed
// the same data).
//
// Two report formats coexist because two coverage backends are in play (see claudedocs/
// client-testing.md and claudedocs/server.md "测试覆盖率"):
//   - vitest workspaces (client + all server/* except engine) emit coverage/coverage-summary.json
//     (the `json-summary` reporter) — a ready-made istanbul-style `{ total: { lines, statements,
//     branches, functions } }` object, no parsing needed.
//   - server/engine runs its compiled dist/ output through Node's own `node --test
//     --experimental-test-coverage`, which only writes lcov (coverage/lcov.info) — summed by hand
//     below from its LF/LH/BRF/BRH/FNF/FNH lines.
//
// 2026-08-20 (ADR-070): the five tools/* packages joined the table in their own "reported, not
// gated" section, and every row gained a "Scope (files)" column — see coverageLib.mjs's
// countSrcFiles for why a percentage is not meaningful here without the size of the scope it was
// measured over.
import { appendFileSync } from 'node:fs';
import { collectRows } from './coverageLib.mjs';

const ROOT = process.cwd();
const rows = collectRows(ROOT);

function fmtPct(metric) {
  return metric ? `${metric.pct.toFixed(1)}%` : '—';
}

/** "measured N of M source files" — see countSrcFiles in coverageLib.mjs for why this is printed. */
function fmtScope(row) {
  if (row.missing || row.srcFiles === 0) return '—';
  return `${row.scopeFiles} / ${row.srcFiles}`;
}

// Overall deliberately sums the GATED packages only (ADR-070). The not-gated tool packages are
// reported below in their own section with their own subtotal: folding them in would silently
// redefine a number that has meant "the coverage the release gate enforces" since 2026-08-15, and
// ops alone (3639 unscoped lines at ~9%) would move it several points on its own.
const overall = { lines: [0, 0], statements: [0, 0], branches: [0, 0], functions: [0, 0] };
for (const row of rows) {
  if (row.missing || !row.gated) continue;
  for (const key of ['lines', 'statements', 'branches', 'functions']) {
    overall[key][0] += row[key].covered;
    overall[key][1] += row[key].total;
  }
}
const overallPct = (key) => (overall[key][1] === 0 ? 0 : (overall[key][0] / overall[key][1]) * 100);

const lines = [];
lines.push('## Test coverage');
lines.push('');
lines.push('| Package | Lines | Statements | Branches | Functions | Scope (files) |');
lines.push('|---|---|---|---|---|---|');
const rowLine = (row) =>
  row.missing
    ? `| ${row.pkg} | — | — | — | — | — |`
    : `| ${row.pkg} | ${fmtPct(row.lines)} | ${fmtPct(row.statements)} | ${fmtPct(row.branches)} | ${fmtPct(row.functions)} | ${fmtScope(row)} |`;

for (const row of rows.filter((r) => r.gated)) lines.push(rowLine(row));
lines.push(`| **Overall (gated)** | **${overallPct('lines').toFixed(1)}%** | **${overallPct('statements').toFixed(1)}%** | **${overallPct('branches').toFixed(1)}%** | **${overallPct('functions').toFixed(1)}%** |  |`);

const notGated = rows.filter((r) => !r.gated);
if (notGated.length > 0) {
  lines.push('| | | | | | |');
  lines.push('| _reported, not gated (ADR-070)_ | | | | | |');
  for (const row of notGated) lines.push(rowLine(row));
}
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
