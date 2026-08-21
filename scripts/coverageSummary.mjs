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

// Every row is gated since ADR-070 Phase 4e retired the "reported, not gated" section that used to
// sit below this table (see coverageLib.mjs). The label stays `Overall (gated)` on purpose: it names
// what the number MEANS — the coverage the release gate actually enforces — which is how every doc
// and note has quoted it since 2026-08-15, and renaming it would break the continuity of a tracked
// number to save one word.
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
lines.push('| Package | Lines | Statements | Branches | Functions | Scope (files) |');
lines.push('|---|---|---|---|---|---|');
const rowLine = (row) =>
  row.missing
    ? `| ${row.pkg} | — | — | — | — | — |`
    : `| ${row.pkg} | ${fmtPct(row.lines)} | ${fmtPct(row.statements)} | ${fmtPct(row.branches)} | ${fmtPct(row.functions)} | ${fmtScope(row)} |`;

for (const row of rows) lines.push(rowLine(row));
lines.push(`| **Overall (gated)** | **${overallPct('lines').toFixed(1)}%** | **${overallPct('statements').toFixed(1)}%** | **${overallPct('branches').toFixed(1)}%** | **${overallPct('functions').toFixed(1)}%** |  |`);
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
