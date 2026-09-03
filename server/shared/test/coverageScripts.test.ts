// Tests for the two repo-root coverage scripts — scripts/coverageSummary.mjs (pure report, must
// never fail) and scripts/checkCoverageThreshold.mjs (the release gate) — plus the package lists
// both read from scripts/coverageLib.mjs.
//
// Sibling of guardScripts.test.ts, same reasoning and same technique: these are gates whose
// failure mode is turning GREEN, and they are driven here through their real CLI entry points
// (spawn node, assert exit code + stdout) against throwaway fixture trees, because the exit code
// is the contract CI consumes. checkCoverageThreshold's own canary covers the "0 packages to
// check" case at runtime; what protects it from the outside is the package-list invariants below,
// since an emptied or duplicated list in coverageLib.mjs is the realistic way that happens.
//
// ADR-070 (2026-08-20) is what made this file worth writing: the gate grew a second class of row
// (`gated: false` — reported, must emit coverage, not held to the percentage yet), and "exempt from
// the bar" is exactly the kind of rule that rots into "exempt from everything" without a test
// pinning the difference.
//
// That second class was temporary by design, and Phase 4a–4e emptied it the same day. Phase 4e
// retired the mechanism with it, so what this file pins about the exemption is now its ABSENCE: see
// "every row is gated, and the not-gated pipeline is retired", which is the direct descendant of
// both the old `expect(NOT_GATED.length).toBeGreaterThan(0)` canary and the two-state version that
// replaced it. It is the one case here that must never become conditional — a silently emptied list
// and a deliberately retired mechanism look identical from the outside unless something asserts the
// difference, and the failure mode it guards (a package dropped from every list, hence measured by
// nothing) reads exactly like a successful retirement.
import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const ROOT_SCRIPTS = join(REPO_ROOT, 'scripts');
const SUMMARY_SCRIPT = join(ROOT_SCRIPTS, 'coverageSummary.mjs');
const THRESHOLD_SCRIPT = join(ROOT_SCRIPTS, 'checkCoverageThreshold.mjs');
const LIB_URL = pathToFileURL(join(ROOT_SCRIPTS, 'coverageLib.mjs')).href;

/**
 * Evaluates `expr` in a child node process with scripts/coverageLib.mjs imported as `lib`, and
 * returns the JSON it printed.
 *
 * Why out-of-process rather than a plain `import` of the module: vitest cannot load a .mjs that
 * lives outside the project root — it fails the whole file with a SyntaxError pointing at the
 * import specifier, since server/shared is the root here and scripts/ is two levels above it.
 * Spawning is also what every other assertion in this file does, so the lists under test are the
 * ones the real CI invocation reads, not a re-import that could resolve somewhere else.
 */
function libEval<T>(expr: string): T {
  const src = `import * as lib from ${JSON.stringify(LIB_URL)};\nconsole.log(JSON.stringify(${expr}));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`libEval(${expr}) failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as T;
}

const LISTS = libEval<{ gatedJson: string[]; lcov: string[] }>(
  '{ gatedJson: lib.JSON_SUMMARY_PACKAGES, lcov: lib.LCOV_PACKAGES }',
);
const { gatedJson: JSON_SUMMARY_PACKAGES, lcov: LCOV_PACKAGES } = LISTS;
const GATED = [...JSON_SUMMARY_PACKAGES, ...LCOV_PACKAGES];

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

const metric = (pct: number) => ({ total: 1000, covered: Math.round(pct * 10), pct });

// Default fixture percentages: one comfortably above the 90% bar, one far below it, so "gated rows
// pass / not-gated rows are reported anyway" is the baseline every case below mutates one thing
// about. Deliberately not any real package's measured number — these used to be 93.4 and 64.3
// (animator's scope figure the day ADR-070 landed), which reads as a snapshot of a specific tool
// and goes quietly stale as that tool's coverage moves or as the tool graduates off the list. All
// the fixture needs is which side of the bar each one is on — plus, for the gated one, that it sits
// between the default 90% bar and the raised bar the COVERAGE_THRESHOLD case below passes in.
const GATED_FIXTURE_PCT = 93;
const RAISED_THRESHOLD = 95;

/**
 * A repo-shaped tree carrying coverage output for every package coverageLib knows about — the
 * baseline that each failure case below mutates exactly one thing about.
 *
 * `pct` overrides one package's LINE percentage (statements and functions follow it, since the
 * v8 provider makes statements identical to lines and no bar is enforced on functions);
 * `branchPct` overrides its BRANCH percentage independently. The two are separate knobs because
 * the whole point of the 2026-09-03 branch bar is the package that is fine on one and not the
 * other — a fixture where every metric moved together could not express the case the gate was
 * added for, and would have made every pre-existing line-coverage case accidentally a branch
 * case too. `omit` drops a package's coverage/ output entirely (the "its step never ran" case,
 * distinct from "it ran and scored 0"); `srcFiles`/`scopeFiles` drive the report's Scope column.
 */
function coverageTree(
  opts: {
    pct?: Record<string, number>;
    branchPct?: Record<string, number>;
    omit?: string[];
    srcFiles?: number;
    scopeFiles?: number;
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'nw-cov-'));
  trees.push(root);
  const pct = opts.pct ?? {};
  const branchPct = opts.branchPct ?? {};
  const omit = new Set(opts.omit ?? []);
  const srcFiles = opts.srcFiles ?? 3;
  const scopeFiles = opts.scopeFiles ?? 2;

  for (const pkg of GATED) {
    for (let i = 0; i < srcFiles; i++) write(root, `${pkg}/src/f${i}.ts`, 'export const x = 1;\n');
    if (omit.has(pkg)) continue;

    const p = pct[pkg] ?? GATED_FIXTURE_PCT;
    const bp = branchPct[pkg] ?? GATED_FIXTURE_PCT;
    if (LCOV_PACKAGES.includes(pkg)) {
      const hit = Math.round(p * 10);
      const brHit = Math.round(bp * 10);
      write(
        root,
        `${pkg}/coverage/lcov.info`,
        `SF:src/f0.ts\nLF:1000\nLH:${hit}\nBRF:1000\nBRH:${brHit}\nFNF:1000\nFNH:${hit}\nend_of_record\n`,
      );
    } else {
      const summary: Record<string, unknown> = {
        total: { lines: metric(p), statements: metric(p), branches: metric(bp), functions: metric(p) },
      };
      for (let i = 0; i < scopeFiles; i++) summary[`/abs/${pkg}/src/f${i}.ts`] = { lines: metric(p) };
      write(root, `${pkg}/coverage/coverage-summary.json`, JSON.stringify(summary));
    }
  }
  return root;
}

function run(script: string, root: string, env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: root, env: { ...process.env, ...env } });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ── scripts/coverageLib.mjs package lists ────────────────────────────────────────────────────────

describe('coverageLib package lists', () => {
  // The outside-in half of checkCoverageThreshold's "0 packages to check" canary: that canary
  // catches an emptied list at runtime, this catches it at review time. Both gated lists must
  // simply be non-empty — there is no future in which this repo legitimately stops measuring the
  // vitest workspaces or server/engine.
  it('keep both gated lists non-empty', () => {
    expect(JSON_SUMMARY_PACKAGES.length).toBeGreaterThan(0);
    expect(LCOV_PACKAGES.length).toBeGreaterThan(0);
  });

  /**
   * ADR-070's exemption is gone, and this is the case that says so on purpose rather than by the
   * absence of anything.
   *
   * Lineage matters here, because this assertion has now been wrong twice in instructive ways.
   * It started as `expect(NOT_GATED.length).toBeGreaterThan(0)` — right intent ("a temporary
   * exemption must not go quiet"), wrong shape: it would have gone red on whichever of Phase
   * 4c/4d/4e merged last, at random, for a change that did exactly what the ADR asked. It then
   * became two-state (non-empty → every entry surfaces as a not-gated row; empty → the exemption is
   * gone from the OUTPUT, not just from the list). Phase 4e emptied the list AND retired the
   * mechanism, so only the second state can hold, and the conditional went with it.
   *
   * What has never changed is the failure it guards, which is why deleting it is the one thing that
   * cannot happen: a package dropped from every list is measured by nothing, and from the outside
   * that looks exactly like a successful retirement. So the assertion is in two halves — the
   * mechanism must be absent from the output, AND every tools/ package must be present in the gated
   * list. Absent-and-present, not absent alone.
   */
  it('every row is gated, and the not-gated pipeline is retired', () => {
    const root = coverageTree();

    // No row carries the old flag at all. Checking for `!== undefined` rather than `!== false`:
    // re-adding the field as a constant `true` would be the halfway state where the mechanism is
    // back but currently unused, which is the shape it would return in.
    const flags = libEval<(boolean | null)[]>(
      `lib.collectRows(${JSON.stringify(root)}).map((r) => r.gated ?? null)`,
    );
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.filter((f) => f !== null)).toEqual([]);

    // Retirement means the five tools/ packages MOVED into the gated list, not that they fell out
    // of the table — the mirror of the copy-instead-of-move mistake the next case pins, and the
    // half the old non-empty assertion used to catch for free. Read off the filesystem rather than
    // named, so this stays true for whatever the tools/ set becomes.
    const toolPkgs = readdirSync(join(REPO_ROOT, 'tools'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(REPO_ROOT, 'tools', e.name, 'vitest.config.ts')))
      .map((e) => `tools/${e.name}`);
    expect(toolPkgs.length).toBeGreaterThan(0);
    for (const pkg of toolPkgs) expect(GATED).toContain(pkg);

    // And neither script still claims to exempt anything.
    for (const script of [SUMMARY_SCRIPT, THRESHOLD_SCRIPT]) {
      const r = run(script, root);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('reported, not gated');
      expect(r.out).not.toContain('Not gated on the');
      expect(r.out).not.toContain('not yet gated');
    }
  });

  // The mistake this exists for: ADR-070 Phase 4 graduated one tool at a time by moving it between
  // lists. Copy the line, forget to delete the original, and the package is silently listed twice —
  // collectRows emits two rows for it and the table reads as if all was well. The third list is
  // gone, but the same slip is still available across the two that remain (a package in both
  // JSON_SUMMARY_PACKAGES and LCOV_PACKAGES would be read by both backends).
  it('never list the same package twice, within or across lists', () => {
    const all = [...JSON_SUMMARY_PACKAGES, ...LCOV_PACKAGES];
    const dupes = all.filter((p, i) => all.indexOf(p) !== i);
    expect(dupes).toEqual([]);
  });

  it('give every row a source-file count', () => {
    const root = coverageTree();
    const rows = libEval<{ pkg: string; srcFiles: number }[]>(
      `lib.collectRows(${JSON.stringify(root)}).map((r) => ({ pkg: r.pkg, srcFiles: r.srcFiles }))`,
    );
    expect(rows.map((r) => r.pkg).sort()).toEqual([...GATED].sort());
    for (const row of rows) expect(row.srcFiles).toBe(3);
  });
});

describe('countSrcFiles', () => {
  it('counts .ts/.tsx under src/, skipping .d.ts, *.test.ts and test dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'nw-cov-'));
    trees.push(root);
    for (const rel of [
      'p/src/a.ts',
      'p/src/nested/b.tsx',
      'p/src/c.d.ts',
      'p/src/d.test.ts',
      'p/src/test/e.ts',
      'p/src/__tests__/f.ts',
      'p/src/g.js',
    ]) {
      write(root, rel, 'export const x = 1;\n');
    }
    expect(libEval<number>(`lib.countSrcFiles(${JSON.stringify(root)}, 'p')`)).toBe(2);
  });

  it('returns 0 for a package with no src/ rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'nw-cov-'));
    trees.push(root);
    expect(libEval<number>(`lib.countSrcFiles(${JSON.stringify(root)}, 'nope')`)).toBe(0);
  });
});

// ── scripts/checkCoverageThreshold.mjs ───────────────────────────────────────────────────────────

describe('checkCoverageThreshold.mjs', () => {
  it('passes when every gated package clears the bar, and says how many were gated', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree());
    expect(r.code).toBe(0);
    expect(r.out).toContain(`all ${GATED.length} gated packages`);
  });

  it('fails a gated package below the bar, quoting its actual percentage', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree({ pct: { 'server/admin': 80.1 } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('below the 90% line-coverage bar');
    // The message gained the headroom in lines (`80.1%, -198 lines`) when that column landed,
    // so this stops at the percentage rather than pinning the whole parenthesis.
    expect(r.out).toContain('server/admin (80.1%');
  });

  // Fails closed on a missing output: we cannot confirm >=90% without the data, and a silent pass
  // would let a broken pipeline masquerade as "coverage is fine". Retargeted from a not-gated
  // subject when ADR-070's exemption retired — the behaviour was never about the exemption, it just
  // happened to be the only thing the gate could catch for an exempt package.
  it('DOES fail a package that produced no coverage at all', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree({ omit: ['server/admin'] }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('produced no coverage output at all');
    expect(r.out).toContain('server/admin');
    // Not a coverage regression, and saying so would send readers hunting for missing tests.
    expect(r.out).not.toContain('below the 90% line-coverage bar');
  });

  it('reports missing output and below-bar failures as separate lines', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree({ omit: ['server/gateway'], pct: { 'server/admin': 12 } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('below the 90% line-coverage bar');
    expect(r.out).toContain('produced no coverage output at all');
  });

  it('skips missing output instead of double-reporting when a test job already failed', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree({ omit: ['server/admin', 'server/gateway'] }), { TESTS_OK: 'false' });
    expect(r.code).toBe(0);
    // Wording, not shouting: the uppercase **NOT ENFORCED** paragraph is the run-summary
    // section's (coverageSummary.mjs renders it), and this script's own log line is the
    // lowercase one. What must not change is that it exits 0 and says how many it skipped.
    expect(r.out).toContain('not enforced');
    expect(r.out).toContain('2 skipped');
  });

  it('honours COVERAGE_THRESHOLD in both directions', () => {
    // 70 sits between the two bars this case passes in, so a threshold that were ignored would give
    // the same verdict twice.
    const tree = coverageTree({ pct: { 'server/admin': 70 } });
    expect(run(THRESHOLD_SCRIPT, tree, { COVERAGE_THRESHOLD: String(RAISED_THRESHOLD) }).code).toBe(1);
    const r = run(THRESHOLD_SCRIPT, tree, { COVERAGE_THRESHOLD: '60' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('>= 60%');
  });

  // ── the branch bar (2026-09-03) ──────────────────────────────────────────────────────────────
  //
  // THE case this bar exists for, and the one no assertion in this file could previously express:
  // a package at 100% lines and 62% branches. That was a green run for a year, across seven
  // packages at once, and the only thing that ever reported it was somebody choosing to read a
  // column by hand. Lines are deliberately pinned ABOVE the bar here — if this case ever starts
  // passing because the gate stopped checking branches, the line half must not accidentally catch
  // it and make the failure look like something else.
  it('fails a package below the branch bar even when its line coverage is perfect', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree({ pct: { 'server/admin': 100 }, branchPct: { 'server/admin': 62 } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('below the 90% branch-coverage bar');
    expect(r.out).toContain('server/admin (62.0%');
    // Not a line failure, and calling it one would send the reader after the wrong work: "add
    // tests for untested lines" and "exercise the other side of a condition you already run" are
    // different jobs.
    expect(r.out).not.toContain('below the 90% line-coverage bar');
  });

  it('reports the line bar and the branch bar as separate lines, naming a package on each', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree({ pct: { 'server/admin': 80 }, branchPct: { 'server/gateway': 70 } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('below the 90% line-coverage bar');
    expect(r.out).toContain('server/admin (80.0%');
    expect(r.out).toContain('below the 90% branch-coverage bar');
    expect(r.out).toContain('server/gateway (70.0%');
  });

  // A package under both bars is named once per bar rather than once in total — each line is
  // addressed to a different piece of work, so dropping it from the second is dropping half the
  // instruction.
  it('names a package under both bars on both lines', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree({ pct: { 'server/admin': 70 }, branchPct: { 'server/admin': 70 } }));
    expect(r.code).toBe(1);
    const lineMsg = r.out.split('\n').find((l) => l.includes('line-coverage bar')) ?? '';
    const branchMsg = r.out.split('\n').find((l) => l.includes('branch-coverage bar')) ?? '';
    expect(lineMsg).toContain('server/admin');
    expect(branchMsg).toContain('server/admin');
  });

  it('honours COVERAGE_BRANCH_THRESHOLD in both directions, independently of the line bar', () => {
    // 85 sits between the raised and lowered branch bars, so a knob that were ignored would give
    // the same verdict twice; lines stay at the passing default throughout, which is what makes
    // this an assertion about the branch bar specifically.
    const tree = coverageTree({ branchPct: { 'server/admin': 85 } });
    expect(run(THRESHOLD_SCRIPT, tree).code).toBe(1);
    const lowered = run(THRESHOLD_SCRIPT, tree, { COVERAGE_BRANCH_THRESHOLD: '80' });
    expect(lowered.code).toBe(0);
    expect(lowered.out).toContain('80% branches');
    const raised = run(THRESHOLD_SCRIPT, tree, { COVERAGE_BRANCH_THRESHOLD: '99' });
    expect(raised.code).toBe(1);
    expect(raised.out).toContain('below the 99% branch-coverage bar');
  });

  // The green log has to name both bars: "all 19 gated packages >= 90%" is what it said while it
  // was checking one metric, and that sentence reading true is precisely how the branch drift went
  // unnoticed.
  it('names both bars in the passing log line', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree());
    expect(r.code).toBe(0);
    expect(r.out).toContain('>= 90% lines / 90% branches');
  });
});

// ── scripts/coverageSummary.mjs ──────────────────────────────────────────────────────────────────

describe('coverageSummary.mjs', () => {
  it('prints a scope column of measured-over-source files', () => {
    const r = run(SUMMARY_SCRIPT, coverageTree({ srcFiles: 7, scopeFiles: 2 }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('| Scope (measured/src) |');
    // The ratio now comes with the division already done — nobody divides 108 by 502 while
    // skimming a 19-row table, which is how the narrowest scope in the repo stayed the least
    // visible thing on the page.
    expect(r.out).toContain('2 / 7 (29%)');
  });

  // Overall has meant "the coverage the release gate enforces" since 2026-08-15, and every package
  // in the table is now part of it. Kept after ADR-070's not-gated section retired because the
  // number itself is what readers quote: it must be the weighted total of the rows above it, not a
  // simple mean of their percentages, or a small package at 0% would barely move it.
  it('totals Overall across every row, weighted by lines', () => {
    const r = run(SUMMARY_SCRIPT, coverageTree({ pct: { 'server/admin': 0 } }));
    const overall = /\*\*Overall \(gated\)\*\* \| \*\*([\d.]+)%\*\*/.exec(r.out);
    expect(overall).not.toBeNull();
    // Every package has 1000 lines in the fixture, so one at 0% among GATED.length of them lands
    // predictably below the 93% baseline and above zero.
    const expected = (GATED_FIXTURE_PCT * (GATED.length - 1)) / GATED.length;
    expect(Number(overall![1])).toBeCloseTo(expected, 0);
  });

  // By design this script must never be the thing that reddens a run (the gate is a separate step).
  it('still exits 0 when coverage output is missing entirely', () => {
    const r = run(SUMMARY_SCRIPT, coverageTree({ omit: [...GATED] }));
    expect(r.code).toBe(0);
    // It reports the breakage in full — it just isn't the thing that sets the exit code.
    expect(r.out).toContain('produced no coverage output at all');
  });
});

// ── the one-section run summary (2026-09-02) ─────────────────────────────────────────────────────
//
// What these pin is a division of labour, not a layout: for a year the run-summary page carried
// TWO headings and TWO full tables — coverageSummary's report and checkCoverageThreshold's gate
// table — whose `Lines` columns were byte-identical and whose `Status` column was N identical ✅
// on every green run, with the actual verdict as the last line under the second one. The section
// is now rendered once, by the report script, and the gate contributes only its exit code.
//
// The reason that needs a test rather than just a comment: nothing about either script's PURPOSE
// stops the gate from appending "just a small failure table" to the summary again, and the second
// time it happens it will look reasonable. The verdict itself cannot drift between the two —
// they get it from one `evaluate` call in coverageLib — but the page can.

describe('run-summary section', () => {
  function renderSummary(root: string, env: Record<string, string> = {}): { code: number; out: string; page: string } {
    const page = join(root, 'step-summary.md');
    const r = run(SUMMARY_SCRIPT, root, { GITHUB_STEP_SUMMARY: page, ...env });
    return { ...r, page: existsSync(page) ? readFileSync(page, 'utf8') : '' };
  }

  it('is one heading, written by the report script, with the gate adding nothing to the page', () => {
    const root = coverageTree();
    const page = join(root, 'step-summary.md');

    const report = renderSummary(root);
    expect(report.code).toBe(0);
    expect(report.page.match(/^## /gm)).toHaveLength(1);

    // The gate runs next in CI and inherits the SAME $GITHUB_STEP_SUMMARY file. It must leave it
    // exactly as it found it — its log is where its output goes now.
    const before = readFileSync(page, 'utf8');
    const gate = run(THRESHOLD_SCRIPT, root, { GITHUB_STEP_SUMMARY: page });
    expect(gate.code).toBe(0);
    expect(readFileSync(page, 'utf8')).toBe(before);
    expect(gate.out).toContain('OK — all');
  });

  it('carries the verdict in the heading instead of under two tables', () => {
    // Both gated bars are named, not just lines: the heading is the one line most readers see, and
    // "✅ 19/19 packages ≥ 90% lines" is the sentence that was true all year while seven packages
    // sat under 90% on branches.
    expect(renderSummary(coverageTree()).page).toContain(
      `## Coverage — ✅ ${GATED.length}/${GATED.length} packages ≥ 90% lines / 90% branches`,
    );

    const failed = renderSummary(coverageTree({ pct: { 'server/admin': 80.1 } }));
    expect(failed.code).toBe(0); // still never the thing that reddens a run
    expect(failed.page).toContain('## Coverage — ❌ 1 below 90% lines');

    const branchFailed = renderSummary(coverageTree({ branchPct: { 'server/admin': 80.1 } }));
    expect(branchFailed.code).toBe(0);
    expect(branchFailed.page).toContain('## Coverage — ❌ 1 below 90% branches');
    expect(branchFailed.page).toContain('below the 90% branch-coverage bar: server/admin (80.1%');

    // Both at once, each counted under its own bar.
    const both = renderSummary(coverageTree({ pct: { 'server/admin': 80 }, branchPct: { 'server/gateway': 80 } }));
    expect(both.page).toContain('## Coverage — ❌ 1 below 90% lines, 1 below 90% branches');

    const skipped = renderSummary(coverageTree({ omit: ['server/admin'] }), { TESTS_OK: 'false' });
    expect(skipped.page).toContain('## Coverage — ⏭️ not enforced (a test job failed)');
  });

  // `measured` used to be "every row we didn't skip", which is a different set the moment a
  // package is missing its coverage/ while the tests passed: the heading claimed "19/19 measured"
  // directly above a paragraph saying one shard had emitted nothing at all. The loudest number on
  // the page contradicting the failure under it is worse than not printing it.
  it('counts only the packages that produced a number as measured', () => {
    const missing = renderSummary(coverageTree({ omit: ['server/admin'] }));
    expect(missing.page).toContain(`${GATED.length - 1}/${GATED.length} measured`);

    const excused = renderSummary(coverageTree({ omit: ['server/admin', 'server/gateway'] }), { TESTS_OK: 'false' });
    expect(excused.page).toContain(`${GATED.length - 2}/${GATED.length} measured`);
  });

  // The column that was missing is the one that made the table worth opening. Without it the rows
  // were 19 absolute percentages in config order, so `90.7%` over 8670 lines (65 lines of slack)
  // and `92.1%` over 924 (19 lines) read identically — and both read as "93%, fine" beside a
  // `100.0%` with hundreds to spare.
  it('prints gate headroom in lines and sorts the most-fragile package first', () => {
    // The two overrides are chosen so headroom order is the REVERSE of alphabetical order —
    // otherwise this case passes just as happily against a plain sort by package name, which is
    // what it looked like the first time it was written.
    const { page } = renderSummary(
      coverageTree({
        pct: { 'server/worldsvc': 91, 'server/admin': 99 },
        // admin's branch percentage is raised alongside its line percentage so its fragility is
        // unambiguously the loosest of the three. Left at the fixture default it would TIE with
        // every other package on branch headroom, the sort would fall through to the alphabetical
        // tiebreak, and `server/admin` would lead the table — a true statement about the sort, but
        // it would stop this case saying anything about headroom ordering.
        branchPct: { 'server/admin': 99 },
      }),
    );
    // 910 of 1000 covered against a 90% bar: 900 must stay covered, so 10 lines may go.
    expect(page).toContain('| server/worldsvc | 91.0% | — | +10 |');
    expect(page).toContain('| server/admin | 99.0% | — | +90 |');
    expect(page.indexOf('| server/worldsvc |')).toBeLessThan(page.indexOf('| server/gateway |'));
    expect(page.indexOf('| server/gateway |')).toBeLessThan(page.indexOf('| server/admin |'));
  });

  // The branch half of the column above. Added with the branch bar (2026-09-03) for the same
  // reason its line twin exists: a percentage on its own does not say how close to the bar it is,
  // and 91.5% over 340 branches (5 to spare) reads identically to 91.9% over 1474 (28 to spare).
  it('prints branch headroom too, and sorts by the TIGHTER of the two headrooms', () => {
    // server/admin: huge line slack, almost none on branches. server/worldsvc: the reverse. Sorted
    // by line headroom alone — the pre-2026-09-03 order — admin would sit at the BOTTOM of the
    // table as the safest-looking row in the repo, which is exactly backwards.
    const { page } = renderSummary(
      coverageTree({
        pct: { 'server/admin': 99, 'server/worldsvc': 91 },
        branchPct: { 'server/admin': 90.1, 'server/worldsvc': 99 },
      }),
    );
    // 901 of 1000 branches against a 90% bar: 900 must stay covered, so 1 may go.
    expect(page).toMatch(/\| server\/admin \| 99\.0% \| — \| \+90 \| 90\.1% \| — \| \+1 \|/);
    expect(page).toMatch(/\| server\/worldsvc \| 91\.0% \| — \| \+10 \| 99\.0% \| — \| \+90 \|/);
    expect(page.indexOf('| server/admin |')).toBeLessThan(page.indexOf('| server/worldsvc |'));
  });

  // `Statements` was identical to `Lines` in every row by construction — the v8 provider makes
  // them the same for the vitest packages, and readLcov aliases one to the other for engine — so
  // it was a column that could not ever disagree with the column beside it.
  it('has no Statements column', () => {
    expect(renderSummary(coverageTree()).page).not.toContain('Statements');
  });

  it('flags a narrow coverage scope rather than leaving the division to the reader', () => {
    expect(renderSummary(coverageTree({ srcFiles: 10, scopeFiles: 2 })).page).toContain('2 / 10 (20%) ⚠️');
    // Checked per-row rather than "no ⚠️ anywhere on the page": the lcov fixture writes a single
    // SF: block, so server/engine is legitimately 1-of-10 in every tree here and flagged for it.
    const wide = renderSummary(coverageTree({ srcFiles: 10, scopeFiles: 9 })).page;
    expect(wide).toMatch(/\| server\/admin \|.*\| 9 \/ 10 \(90%\) \|/);
    expect(wide).not.toMatch(/\| server\/admin \|.*⚠️/);
  });
});

// ── Δ against the previous green main (2026-09-02) ───────────────────────────────────────────────
//
// The question a reader of a GREEN run actually arrives with is "did it move", and for a year the
// table could not answer it. ci.yml carries the baseline between runs via actions/cache (saved
// only on a green push to main, restored everywhere), which is CI plumbing these cases can't
// reach — what they pin is the contract that plumbing depends on: the file round-trips, an absent
// or corrupt one is the boring path rather than a failure, and a package that dropped while still
// clearing the bar is named ABOVE the fold. That last one is the whole point: 90.1% arrived one
// unnoticed tenth at a time.

describe('coverage baseline (Δ column)', () => {
  it('round-trips a baseline it wrote itself, and reports no movement', () => {
    const root = coverageTree();
    const baseline = join(root, 'baseline.json');
    expect(run(SUMMARY_SCRIPT, root, { COVERAGE_BASELINE_OUT: baseline }).code).toBe(0);
    expect(existsSync(baseline)).toBe(true);

    const again = run(SUMMARY_SCRIPT, root, { COVERAGE_BASELINE_IN: baseline });
    expect(again.out).toContain('±0');
    expect(again.out).not.toContain('Line coverage dropped');
    expect(again.out).not.toContain('No baseline from a previous run');
  });

  it('names a package that dropped while still clearing the bar, above the fold', () => {
    const root = coverageTree();
    const baseline = join(root, 'baseline.json');
    run(SUMMARY_SCRIPT, root, { COVERAGE_BASELINE_OUT: baseline });

    // One point lower on one package — comfortably still over 90%, i.e. invisible to the gate.
    const dropped = coverageTree({ pct: { 'server/admin': GATED_FIXTURE_PCT - 1 } });
    const r = run(SUMMARY_SCRIPT, dropped, { COVERAGE_BASELINE_IN: baseline });
    expect(r.code).toBe(0);
    expect(r.out).toContain('## Coverage — ✅');
    expect(r.out).toContain('Line coverage dropped in 1 package(s)');
    expect(r.out).toContain('server/admin -1.0');
    // Above the fold, not inside the collapsed table — that is the only reason to compute it.
    expect(r.out.indexOf('Line coverage dropped')).toBeLessThan(r.out.indexOf('<details>'));
  });

  // The branch twin (2026-09-03). The baseline file has carried the branch percentage since it was
  // written — nothing read it — so this is the drift that could happen with every number on the
  // page still green: a package sheds branch coverage, stays over 90%, and no line moves.
  it('names a package whose BRANCH coverage dropped while still clearing both bars', () => {
    const root = coverageTree();
    const baseline = join(root, 'baseline.json');
    run(SUMMARY_SCRIPT, root, { COVERAGE_BASELINE_OUT: baseline });

    const dropped = coverageTree({ branchPct: { 'server/admin': GATED_FIXTURE_PCT - 1 } });
    const r = run(SUMMARY_SCRIPT, dropped, { COVERAGE_BASELINE_IN: baseline });
    expect(r.code).toBe(0);
    expect(r.out).toContain('## Coverage — ✅');
    expect(r.out).toContain('Branch coverage dropped in 1 package(s)');
    expect(r.out).toContain('server/admin -1.0');
    // Not reported as a line drop — no line moved.
    expect(r.out).not.toContain('Line coverage dropped');
    expect(r.out.indexOf('Branch coverage dropped')).toBeLessThan(r.out.indexOf('<details>'));
  });

  it('marks a package the baseline never saw as new, not as a move', () => {
    const root = coverageTree();
    const baseline = join(root, 'baseline.json');
    run(SUMMARY_SCRIPT, root, { COVERAGE_BASELINE_OUT: baseline });
    const parsed = JSON.parse(readFileSync(baseline, 'utf8')) as { rows: Record<string, unknown> };
    delete parsed.rows['server/admin'];
    writeFileSync(baseline, JSON.stringify(parsed), 'utf8');

    const r = run(SUMMARY_SCRIPT, root, { COVERAGE_BASELINE_IN: baseline });
    expect(r.out).toMatch(/\| server\/admin \|[^|]+\| new \|/);
    expect(r.out).not.toContain('Line coverage dropped');
  });

  // Absent on the first run after this landed, after a cache eviction, and on every local
  // invocation — so it has to be the quiet path, and it has to SAY the column is blank rather than
  // print a page of ±0 that reads as "nothing changed".
  it('degrades to a blank Δ column when the baseline is missing or corrupt', () => {
    const root = coverageTree();
    const missing = run(SUMMARY_SCRIPT, root, { COVERAGE_BASELINE_IN: join(root, 'nope.json') });
    expect(missing.code).toBe(0);
    expect(missing.out).toContain('No baseline from a previous run was available');

    const corrupt = join(root, 'corrupt.json');
    writeFileSync(corrupt, 'not json at all', 'utf8');
    const r = run(SUMMARY_SCRIPT, root, { COVERAGE_BASELINE_IN: corrupt });
    expect(r.code).toBe(0);
    expect(r.out).toContain('No baseline from a previous run was available');
  });
});

describe('gateHeadroom', () => {
  it('counts the covered lines a package could lose before breaching the bar', () => {
    // 950 of 1000 against a 90% bar: 900 must stay covered, so 50 may go.
    expect(libEval<number>('lib.gateHeadroom({ lines: { covered: 950, total: 1000 } }, 90)')).toBe(50);
    // Already under: negative, and by the number of lines that would have to be covered to fix it.
    expect(libEval<number>('lib.gateHeadroom({ lines: { covered: 880, total: 1000 } }, 90)')).toBe(-20);
    // The bar is a knob, so the headroom moves with it — not hard-coded to 90 anywhere.
    expect(libEval<number>('lib.gateHeadroom({ lines: { covered: 950, total: 1000 } }, 95)')).toBe(0);
    expect(libEval<number | null>('lib.gateHeadroom({ missing: true }, 90) ?? null')).toBe(null);
  });

  // The same arithmetic over the other gated metric. `metric` defaults to 'lines' so the four
  // assertions above still describe every existing caller.
  it('does the same for branches when asked, and still defaults to lines', () => {
    const row = '{ lines: { covered: 990, total: 1000 }, branches: { covered: 910, total: 1000 } }';
    expect(libEval<number>(`lib.gateHeadroom(${row}, 90, 'branches')`)).toBe(10);
    expect(libEval<number>(`lib.gateHeadroom(${row}, 90)`)).toBe(90);
    expect(libEval<number>(`lib.gateHeadroom(${row}, 90, 'lines')`)).toBe(90);
    expect(libEval<number | null>("lib.gateHeadroom({ missing: true }, 90, 'branches') ?? null")).toBe(null);
  });
});

// ── the branch bar's own wiring (2026-09-03) ─────────────────────────────────────────────────────
//
// Two constants and two lists, pinned from the outside because each has a plausible way to go
// quietly wrong: a branch bar defaulting to 0 would pass everything while looking configured, and
// a `belowBranchBar` that were derived from `!reason` (the way `belowBar` was while there was one
// bar) would classify every branch failure as a line failure.
describe('branch gate wiring', () => {
  it('defaults both bars to 90 and reads each from its own env var', () => {
    expect(libEval<number>('lib.DEFAULT_BRANCH_THRESHOLD')).toBe(90);
    expect(libEval<{ threshold: number; branchThreshold: number }>('lib.readGateEnv({})')).toEqual({
      threshold: 90,
      branchThreshold: 90,
      testsOk: true,
    });
    // Each var moves only its own bar — a single shared knob would be a silent coupling.
    expect(
      libEval<{ threshold: number; branchThreshold: number }>(
        "lib.readGateEnv({ COVERAGE_THRESHOLD: '70' })",
      ),
    ).toMatchObject({ threshold: 70, branchThreshold: 90 });
    expect(
      libEval<{ threshold: number; branchThreshold: number }>(
        "lib.readGateEnv({ COVERAGE_BRANCH_THRESHOLD: '70' })",
      ),
    ).toMatchObject({ threshold: 90, branchThreshold: 70 });
  });

  it('sorts each failing package into the list for the bar it actually breached', () => {
    const root = coverageTree({
      pct: { 'server/admin': 70 },
      branchPct: { 'server/gateway': 70, 'server/admin': 70 },
    });
    const ev = libEval<{ belowBar: string[]; belowBranchBar: string[]; verdict: string }>(
      `(() => { const e = lib.evaluate(${JSON.stringify(root)}, lib.readGateEnv({})); return { ` +
        'belowBar: e.belowBar.map((f) => f.pkg), belowBranchBar: e.belowBranchBar.map((f) => f.pkg), ' +
        'verdict: e.verdict }; })()',
    );
    expect(ev.verdict).toBe('fail');
    // admin breached both, so it is in both lists; gateway breached only the branch bar.
    expect(ev.belowBar).toEqual(['server/admin']);
    expect(ev.belowBranchBar.sort()).toEqual(['server/admin', 'server/gateway']);
  });
});
