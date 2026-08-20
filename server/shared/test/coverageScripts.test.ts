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
import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_SCRIPTS = resolve(HERE, '..', '..', '..', 'scripts');
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

const LISTS = libEval<{ gatedJson: string[]; lcov: string[]; notGated: string[] }>(
  '{ gatedJson: lib.JSON_SUMMARY_PACKAGES, lcov: lib.LCOV_PACKAGES, notGated: lib.NOT_GATED_JSON_SUMMARY_PACKAGES }',
);
const { gatedJson: JSON_SUMMARY_PACKAGES, lcov: LCOV_PACKAGES, notGated: NOT_GATED_JSON_SUMMARY_PACKAGES } = LISTS;
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

  for (const pkg of [...GATED, ...NOT_GATED_JSON_SUMMARY_PACKAGES]) {
    for (let i = 0; i < srcFiles; i++) write(root, `${pkg}/src/f${i}.ts`, 'export const x = 1;\n');
    if (omit.has(pkg)) continue;

    const p = pct[pkg] ?? (NOT_GATED_JSON_SUMMARY_PACKAGES.includes(pkg) ? 64.3 : 93.4);
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
  // catches an emptied list at runtime, this catches it at review time.
  it('are all non-empty', () => {
    expect(JSON_SUMMARY_PACKAGES.length).toBeGreaterThan(0);
    expect(LCOV_PACKAGES.length).toBeGreaterThan(0);
    expect(NOT_GATED_JSON_SUMMARY_PACKAGES.length).toBeGreaterThan(0);
  });

  // The mistake this exists for: ADR-070 Phase 4 graduates one tool at a time by moving it from
  // the not-gated list into JSON_SUMMARY_PACKAGES. Copy the line, forget to delete the original,
  // and the package is silently both gated and exempt — collectRows would emit two rows for it,
  // the gate would pass it on the exempt row, and the table would read as if all was well.
  it('never list the same package twice, within or across lists', () => {
    const all = [...JSON_SUMMARY_PACKAGES, ...LCOV_PACKAGES, ...NOT_GATED_JSON_SUMMARY_PACKAGES];
    const dupes = all.filter((p, i) => all.indexOf(p) !== i);
    expect(dupes).toEqual([]);
  });

  it('keep the not-gated exemption scoped to tools/', () => {
    for (const pkg of NOT_GATED_JSON_SUMMARY_PACKAGES) expect(pkg.startsWith('tools/')).toBe(true);
  });

  it('mark every row gated or not, with a source-file count', () => {
    const root = coverageTree();
    const rows = libEval<{ pkg: string; gated: boolean; srcFiles: number }[]>(
      `lib.collectRows(${JSON.stringify(root)}).map((r) => ({ pkg: r.pkg, gated: r.gated, srcFiles: r.srcFiles }))`,
    );
    expect(rows).toHaveLength(GATED.length + NOT_GATED_JSON_SUMMARY_PACKAGES.length);
    expect(rows.filter((r) => r.gated).map((r) => r.pkg).sort()).toEqual([...GATED].sort());
    expect(rows.filter((r) => !r.gated).map((r) => r.pkg).sort()).toEqual([...NOT_GATED_JSON_SUMMARY_PACKAGES].sort());
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

  // The core ADR-070 contract: exempt from the percentage, not from the pipeline.
  it('does NOT fail a not-gated package far below the bar', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree({ pct: { 'tools/ops': 8.8 } }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('reported, not gated');
    expect(r.out).toContain('tools/ops 8.8%');
  });

  it('DOES fail a not-gated package that produced no coverage at all', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree({ omit: ['tools/ops'] }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('produced no coverage output at all');
    expect(r.out).toContain('tools/ops');
    // Not a coverage regression, and saying so would send readers hunting for missing tests.
    expect(r.out).not.toContain('below the 90% line-coverage bar');
  });

  it('reports missing output and below-bar failures as separate lines', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree({ omit: ['tools/ops'], pct: { 'server/admin': 12 } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('below the 90% line-coverage bar');
    expect(r.out).toContain('produced no coverage output at all');
  });

  it('skips missing output instead of double-reporting when a test job already failed', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree({ omit: ['tools/ops', 'server/admin'] }), { TESTS_OK: 'false' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('NOT ENFORCED');
    expect(r.out).toContain('2 skipped');
  });

  it('honours COVERAGE_THRESHOLD, and never applies it to the not-gated rows', () => {
    const tree = coverageTree({ pct: { 'tools/ops': 70 } });
    expect(run(THRESHOLD_SCRIPT, tree, { COVERAGE_THRESHOLD: '95' }).code).toBe(1);
    const r = run(THRESHOLD_SCRIPT, tree, { COVERAGE_THRESHOLD: '60' });
    expect(r.code).toBe(0);
    // 70% clears a 60% bar, but the row is still printed as exempt rather than as a pass.
    expect(r.out).toContain('reported, not gated — target 60%');
  });

  it('restates the not-gated gap on a passing run, not only on failure', () => {
    const r = run(THRESHOLD_SCRIPT, coverageTree());
    expect(r.code).toBe(0);
    for (const pkg of NOT_GATED_JSON_SUMMARY_PACKAGES) expect(r.out).toContain(pkg);
    expect(r.out).toContain('claudedocs/tools-testing.md');
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

  it('separates the not-gated packages into their own section', () => {
    const r = run(SUMMARY_SCRIPT, coverageTree());
    expect(r.out).toContain('_reported, not gated (ADR-070)_');
    for (const pkg of NOT_GATED_JSON_SUMMARY_PACKAGES) expect(r.out).toContain(`| ${pkg} |`);
  });

  // Overall has meant "the coverage the release gate enforces" since 2026-08-15. A 0% tool must
  // not move it, or every reader of that number silently gets a different one than they think.
  it('keeps not-gated packages out of the Overall row', () => {
    const zeroed = Object.fromEntries(NOT_GATED_JSON_SUMMARY_PACKAGES.map((p) => [p, 0]));
    const r = run(SUMMARY_SCRIPT, coverageTree({ pct: zeroed }));
    const overall = /\*\*Overall \(gated\)\*\* \| \*\*([\d.]+)%\*\*/.exec(r.out);
    expect(overall).not.toBeNull();
    expect(Number(overall![1])).toBeGreaterThan(90);
  });

  // By design this script must never be the thing that reddens a run (the gate is a separate step).
  it('still exits 0 when coverage output is missing entirely', () => {
    const r = run(SUMMARY_SCRIPT, coverageTree({ omit: [...GATED, ...NOT_GATED_JSON_SUMMARY_PACKAGES] }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('No coverage/ output found for');
  });
});
