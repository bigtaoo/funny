#!/usr/bin/env node
// Renders the ONE run-summary section the coverage steps put on the CI run page, from the
// evaluation object scripts/coverageLib.mjs produces. Presentation only: it reads no files, makes
// no decisions, and never fails — `evaluate` already decided everything, including the verdict.
//
// Why this is its own module (2026-09-02): coverageLib is the shared READING logic (package lists,
// two coverage-backend parsers, the gate decision), and stapling ~170 lines of markdown assembly
// onto it pushed it to 496 lines — a hair under the 500-line rule the rest of the repo lives by,
// and past the point where the file has one job. The two halves also have exactly one thing in
// common, which is the evaluation object, so there is nothing to share by keeping them together.
//
// What the section replaced, and why any change here should keep it: coverageSummary.mjs used to
// write a `## Test coverage` table and checkCoverageThreshold.mjs then appended a SECOND heading
// with a second full table whose `Lines` column was byte-identical to the first's and whose
// `Status` column was 19 identical ✅ on every green run — ~40 rows of page for one bit of
// information, with the verdict as the last line under the second table. See
// claudedocs/server-testing-tooling.md "运行摘要读不下去" for the full list of what was wrong with
// it, and server/shared/test/coverageScripts.test.ts's `run-summary section` for what is now
// pinned: one heading, the gate contributing nothing to the page, failures and regressions above
// the fold, headroom-sorted rows below it.

// ─── Rendering ───────────────────────────────────────────────────────────────────────────────────

/** Percentage-point moves below this are rounding on a multi-thousand-line package, not
 *  regressions; printing them as ±0.0 arrows would train readers to ignore the column. */
const DELTA_EPSILON = 0.05;
/** A package measuring less than this fraction of its own src/ gets flagged in the Scope column. */
const NARROW_SCOPE = 0.6;

const fmtPct = (n) => `${n.toFixed(1)}%`;
const fmtSigned = (n, digits = 1) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(digits)}`;

function fmtDelta(pct, basePct) {
  if (basePct === undefined || basePct === null) return 'new';
  const d = pct - basePct;
  return Math.abs(d) < DELTA_EPSILON ? '±0' : fmtSigned(d);
}

/** "measured N of M source files (P%)", flagged when P is low.
 *
 *  Why the flag and not just the ratio (ADR-070): a package's percentage is measured over whatever
 *  its `coverage.include` selects, and several here deliberately select less than their whole tree.
 *  That is a documented choice, but it is also the one knob that raises a percentage without adding
 *  a test. The ratio was already printed — but nobody divides 108 by 502 while skimming a 19-row
 *  table, so the row that most deserved a second look was the least visible one on the page. */
function fmtScope(row) {
  if (row.missing || !row.srcFiles) return '—';
  const frac = row.scopeFiles / row.srcFiles;
  return `${row.scopeFiles} / ${row.srcFiles} (${Math.round(frac * 100)}%)${frac < NARROW_SCOPE ? ' ⚠️' : ''}`;
}

/** The verdict, in the heading. It used to be the last line under two full tables.
 *
 *  Both gated bars are named (2026-09-03): a heading that said only "≥ 90% lines" on a green run
 *  was the exact reading that let branch coverage drift for a year with everything looking fine. */
function heading(ev) {
  const overall = fmtPct(ev.overall.lines);
  const bar = `${ev.threshold}%`;
  const brBar = `${ev.branchThreshold}%`;
  if (ev.verdict === 'empty') return '## Coverage — ❌ nothing measured (0 packages)';
  if (ev.verdict === 'fail') {
    const parts = [];
    if (ev.belowBar.length > 0) parts.push(`${ev.belowBar.length} below ${bar} lines`);
    if (ev.belowBranchBar.length > 0) parts.push(`${ev.belowBranchBar.length} below ${brBar} branches`);
    if (ev.missingOutput.length > 0) parts.push(`${ev.missingOutput.length} with no coverage output`);
    return `## Coverage — ❌ ${parts.join(', ')} · ${ev.measured}/${ev.rows.length} measured · overall ${overall}`;
  }
  if (ev.verdict === 'not-enforced') {
    return `## Coverage — ⏭️ not enforced (a test job failed) · ${ev.measured}/${ev.rows.length} measured ≥ ${bar} · overall ${overall}`;
  }
  return `## Coverage — ✅ ${ev.measured}/${ev.rows.length} packages ≥ ${bar} lines / ${brBar} branches · overall ${overall}`;
}

/**
 * The single run-summary section: a verdict-carrying heading, everything that needs acting on
 * (failures, regressions) in plain sight above the fold, and the per-package table inside a
 * `<details>` — so the default view of a green run is three lines instead of two 19-row tables,
 * and the breakdown is one click away for whoever wants it.
 *
 * Rows are sorted by gate headroom ascending, i.e. most-fragile first. The previous order was the
 * order of the two package lists above, which put `server/engine` last for no reason except that
 * it is the one read by the lcov parser, and put nothing interesting anywhere in particular.
 */
export function renderSection(ev, baseline = null) {
  const base = baseline?.rows ?? {};
  const hasBaseline = Object.keys(base).length > 0;
  const out = [heading(ev), ''];

  if (ev.verdict === 'empty') {
    out.push(
      '**FAILED** — 0 packages to check. Every assertion in the gate iterates that list, so this ' +
        "run verified nothing (coverageLib.mjs's package lists are empty, or this was not run from " +
        'the repo root).',
      '',
    );
    return out.join('\n');
  }

  if (ev.belowBar.length > 0) {
    out.push(
      `**FAILED** — ${ev.belowBar.length} package(s) below the ${ev.threshold}% line-coverage bar: ${ev.belowBar
        .map((f) => `${f.pkg} (${fmtPct(f.pct)}, ${fmtSigned(f.headroom, 0)} lines)`)
        .join(', ')}.`,
      '',
    );
  }
  if (ev.belowBranchBar.length > 0) {
    out.push(
      `**FAILED** — ${ev.belowBranchBar.length} package(s) below the ${ev.branchThreshold}% branch-coverage bar: ${ev.belowBranchBar
        .map((f) => `${f.pkg} (${fmtPct(f.branchPct)}, ${fmtSigned(f.branchHeadroom, 0)} branches)`)
        .join(', ')}.`,
      '',
    );
  }
  if (ev.missingOutput.length > 0) {
    out.push(
      `**FAILED** — ${ev.missingOutput.length} package(s) produced no coverage output at all: ${ev.missingOutput
        .map((f) => f.pkg)
        .join(', ')}. That is a broken test/coverage step, not a coverage regression — every package on the list must emit coverage/.`,
      '',
    );
  }
  if (ev.skipped > 0) {
    out.push(
      '_A test job in this run failed, so packages without coverage output are skipped rather than ' +
        'reported as gate failures — the run is already red. Fix the failing tests; this gate ' +
        're-arms on the next run._',
      '',
    );
  }

  // Regressions go above the fold even on a green run: still clearing the bar while shedding a
  // point is exactly the state that ends with a package at 90.1% and nobody having noticed.
  const dropsIn = (metric, pctOf) =>
    ev.results
      .filter(
        (r) =>
          pctOf(r) !== undefined &&
          base[r.pkg] !== undefined &&
          base[r.pkg][metric] - pctOf(r) > DELTA_EPSILON * 2,
      )
      .map((r) => ({ pkg: r.pkg, d: pctOf(r) - base[r.pkg][metric] }))
      .sort((a, b) => a.d - b.d);

  const drops = dropsIn('lines', (r) => r.pct);
  if (drops.length > 0) {
    out.push(
      `⚠️ Line coverage dropped in ${drops.length} package(s) since the last green \`main\`: ${drops
        .map((d) => `${d.pkg} ${fmtSigned(d.d)}`)
        .join(', ')}.`,
      '',
    );
  }
  // Branch drops get the same treatment (2026-09-03), and for the same reason the line version
  // exists: a package that sheds branch coverage while still clearing 90% is invisible to the gate,
  // and the baseline file has always carried the branch number — nothing was reading it.
  const branchDrops = dropsIn('branches', (r) => r.branchPct);
  if (branchDrops.length > 0) {
    out.push(
      `⚠️ Branch coverage dropped in ${branchDrops.length} package(s) since the last green \`main\`: ${branchDrops
        .map((d) => `${d.pkg} ${fmtSigned(d.d)}`)
        .join(', ')}.`,
      '',
    );
  }

  out.push('<details><summary>per-package breakdown (most-fragile first)</summary>', '');
  out.push('| Package | Lines | Δ | Headroom | Branches | Δ br | Br. headroom | Functions | Scope (measured/src) |');
  out.push('|---|--:|--:|--:|--:|--:|--:|--:|---|');

  // `Statements` is gone from this table (2026-09-02): the v8 provider makes it identical to
  // `Lines` for every vitest package, and readLcov above literally aliases one to the other, so it
  // was 19 rows of a column that could not differ from the column beside it.
  //
  // Sorted by the TIGHTER of the two headrooms (2026-09-03). "Most fragile first" was line
  // headroom while lines were the only gated metric; with two bars, a package with 400 lines of
  // slack and 3 branches of slack is the fragile one and line headroom alone sorts it to the bottom.
  const fragility = (r) =>
    r.row.missing ? -Infinity : Math.min(r.headroom, r.branchHeadroom);
  const sorted = ev.results
    .slice()
    .sort((a, b) => fragility(a) - fragility(b) || a.pkg.localeCompare(b.pkg));
  for (const r of sorted) {
    if (r.row.missing) {
      const note = r.reason?.startsWith('not evaluated')
        ? '⏭️ its test job failed'
        : '❌ no coverage/ output';
      out.push(`| ${r.pkg} | — | — | — | — | — | — | — | ${note} |`);
      continue;
    }
    const row = r.row;
    const delta = hasBaseline ? fmtDelta(row.lines.pct, base[r.pkg]?.lines) : '—';
    const brDelta = hasBaseline ? fmtDelta(row.branches.pct, base[r.pkg]?.branches) : '—';
    out.push(
      `| ${r.pkg} | ${fmtPct(row.lines.pct)} | ${delta} | ${fmtSigned(r.headroom, 0)} | ${fmtPct(row.branches.pct)} | ${brDelta} | ${fmtSigned(r.branchHeadroom, 0)} | ${fmtPct(row.functions.pct)} | ${fmtScope(row)} |`,
    );
  }

  // The label stays `Overall (gated)` on purpose: it names what the number MEANS — the coverage the
  // release gate actually enforces — which is how every doc and note has quoted it since
  // 2026-08-15, and renaming it would break the continuity of a tracked number to save one word.
  const overallDelta =
    hasBaseline && baseline.overall ? fmtDelta(ev.overall.lines, baseline.overall.lines) : '—';
  const overallBrDelta =
    hasBaseline && baseline.overall ? fmtDelta(ev.overall.branches, baseline.overall.branches) : '—';
  out.push(
    `| **Overall (gated)** | **${fmtPct(ev.overall.lines)}** | **${overallDelta}** |  | **${fmtPct(ev.overall.branches)}** | **${overallBrDelta}** |  | **${fmtPct(ev.overall.functions)}** |  |`,
  );
  out.push('', '</details>', '');

  if (!hasBaseline) {
    out.push(
      '_No baseline from a previous run was available, so Δ is blank. It fills in once a green ' +
        'push to `main` has stored one._',
      '',
    );
  }
  return out.join('\n');
}
