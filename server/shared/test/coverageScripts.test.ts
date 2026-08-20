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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
 * `pct` overrides one package's percentage; `omit` drops one package's coverage/ output entirely
 * (the "its step never ran" case, which is distinct from "it ran and scored 0"); `srcFiles`/
 * `scopeFiles` drive the report's Scope column.
 */
function coverageTree(
  opts: { pct?: Record<string, number>; omit?: string[]; srcFiles?: number; scopeFiles?: number } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'nw-cov-'));
  trees.push(root);
  const pct = opts.pct ?? {};
  const omit = new Set(opts.omit ?? []);
  const srcFiles = opts.srcFiles ?? 3;
  const scopeFiles = opts.scopeFiles ?? 2;

  for (const pkg of GATED) {
    for (let i = 0; i < srcFiles; i++) write(root, `${pkg}/src/f${i}.ts`, 'export const x = 1;\n');
    if (omit.has(pkg)) continue;

    const p = pct[pkg] ?? GATED_FIXTURE_PCT;
    if (LCOV_PACKAGES.includes(pkg)) {
      const hit = Math.round(p * 10);
      write(
        root,
        `${pkg}/coverage/lcov.info`,
        `SF:src/f0.ts\nLF:1000\nLH:${hit}\nBRF:1000\nBRH:${hit}\nFNF:1000\nFNH:${hit}\nend_of_record\n`,
      );
    } else {
      const summary: Record<string, unknown> = {
        total: { lines: metric(p), statements: metric(p), branches: metric(p), functions: metric(p) },
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
    expect(r.out).toContain('server/admin (80.1%)');
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
    expect(r.out).toContain('NOT ENFORCED');
    expect(r.out).toContain('2 skipped');
  });

  it('honours COVERAGE_THRESHOLD in both directions', () => {
    // 70 sits between the two bars this case passes in, so a threshold that were ignored would give
    // the same verdict twice.
    const tree = coverageTree({ pct: { 'server/admin': 70 } });
    expect(run(THRESHOLD_SCRIPT, tree, { COVERAGE_THRESHOLD: String(RAISED_THRESHOLD) }).code).toBe(1);
    const r = run(THRESHOLD_SCRIPT, tree, { COVERAGE_THRESHOLD: '60' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('>= 60% lines per package');
  });
});

// ── scripts/coverageSummary.mjs ──────────────────────────────────────────────────────────────────

describe('coverageSummary.mjs', () => {
  it('prints a scope column of measured-over-source files', () => {
    const r = run(SUMMARY_SCRIPT, coverageTree({ srcFiles: 7, scopeFiles: 2 }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('| Scope (files) |');
    expect(r.out).toContain('2 / 7');
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
    expect(r.out).toContain('No coverage/ output found for');
  });
});
