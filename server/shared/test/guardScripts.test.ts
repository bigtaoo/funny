// Tests for the two CI guard scripts that had none: server/scripts/checkWorkspaceCoverage.mjs and
// the shared root scripts/checkFileLength.mjs.
//
// Why these need tests at all, when they ARE the tests for everything else: both fail by turning
// GREEN. checkWorkspaceCoverage reported a cheerful "OK — all 0 workspaces" on an empty workspace
// list, and checkFileLength exited 0 after scanning 0 files — a wrong --root, a widened exclude rule,
// or a renamed key and the gate stops gating while CI stays green. Nothing would have noticed.
// checkDocLinks.mjs already carried a canary for exactly this; these two now do too, and these tests
// are what keep the canaries (and the rest of the logic) honest.
//
// They drive the real CLI entry points — spawn node, assert exit code + stdout — against throwaway
// fixture trees, rather than importing internals. That is deliberate: the exit code IS the contract
// CI consumes, and `--root=` (added to checkWorkspaceCoverage for this, same spelling as the sibling
// script already used) is the only seam needed to point them somewhere other than the real repo.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COVERAGE_SCRIPT = resolve(HERE, '..', '..', 'scripts', 'checkWorkspaceCoverage.mjs');
const FILELENGTH_SCRIPT = resolve(HERE, '..', '..', '..', 'scripts', 'checkFileLength.mjs');

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** Writes a throwaway directory tree from a {relative path -> contents} map; auto-removed after each test. */
function tree(spec: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'nw-guard-'));
  trees.push(root);
  for (const [rel, content] of Object.entries(spec)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function run(script: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const json = (v: unknown): string => JSON.stringify(v);
const lines = (n: number): string => `export const x = 1;\n`.repeat(n);

// ── server/scripts/checkWorkspaceCoverage.mjs ────────────────────────────────────────────────────

/**
 * A tree that passes every check, as the baseline the failure cases mutate one field of.
 * `testConfig: null` omits the tsconfig.test.json entirely; `fulllinkInclude: null` omits the owner
 * program — the two "the file simply isn't there" cases, distinct from an empty config.
 */
function coverageTree(opts: {
  workspaces?: string[];
  references?: string[];
  testConfig?: Record<string, unknown> | null;
  typecheckTestScript?: boolean;
  fulllinkInclude?: string[] | null;
} = {}): string {
  const workspaces = opts.workspaces ?? ['shared'];
  const references = opts.references ?? workspaces;
  const spec: Record<string, string> = {
    'server/package.json': json({ workspaces }),
    'server/tsconfig.build.json': json({ references: references.map((p) => ({ path: p })) }),
  };
  for (const w of workspaces) {
    spec[`server/${w}/package.json`] = json({
      name: `@nw/${w}`,
      scripts: (opts.typecheckTestScript ?? true) ? { 'typecheck:test': 'tsc --noEmit -p tsconfig.test.json' } : {},
    });
    if (opts.testConfig !== null) spec[`server/${w}/tsconfig.test.json`] = json(opts.testConfig ?? {});
  }
  if (opts.fulllinkInclude !== null) {
    spec['client/tsconfig.fulllink.json'] = json({ include: opts.fulllinkInclude ?? [] });
  }
  return tree(spec);
}

const runCoverage = (root: string) => run(COVERAGE_SCRIPT, [`--root=${join(root, 'server')}`]);

describe('checkWorkspaceCoverage.mjs', () => {
  it('passes a tree where every workspace is referenced, typed and scripted', () => {
    const r = runCoverage(coverageTree());
    expect(r.out).toContain('OK — all 1 workspaces');
    expect(r.code).toBe(0);
  });

  /**
   * The canary. Before this existed the script printed "OK — all 0 workspaces" and exited 0: every
   * loop in it iterates `package.json#workspaces`, so an empty list verifies nothing while looking
   * like a clean run. This is the failure mode the whole file exists for.
   */
  it('canary: an empty workspace list FAILS instead of vacuously reporting OK', () => {
    const r = runCoverage(coverageTree({ workspaces: [] }));
    expect(r.out).toContain('lists no workspaces');
    expect(r.out).not.toContain('OK —');
    expect(r.code).toBe(1);
  });

  it('fails when a workspace is missing from tsconfig.build.json#references (its CI type-check would be skipped)', () => {
    const r = runCoverage(coverageTree({ workspaces: ['shared', 'engine'], references: ['shared'] }));
    expect(r.out).toContain('gets zero CI type-checking');
    expect(r.out).toContain('- engine');
    expect(r.code).toBe(1);
  });

  it('fails on a stale reference that no longer names a workspace', () => {
    const r = runCoverage(coverageTree({ workspaces: ['shared'], references: ['shared', 'deleted-svc'] }));
    expect(r.out).toContain('stale/renamed entry');
    expect(r.out).toContain('- deleted-svc');
    expect(r.code).toBe(1);
  });

  it('fails when a workspace has no tsconfig.test.json', () => {
    const r = runCoverage(coverageTree({ testConfig: null }));
    expect(r.out).toContain('no tsconfig.test.json');
    expect(r.code).toBe(1);
  });

  it('fails when a workspace has no typecheck:test script (the root fan-out uses --if-present and would skip it silently)', () => {
    const r = runCoverage(coverageTree({ typecheckTestScript: false }));
    expect(r.out).toContain('no "typecheck:test" script');
    expect(r.code).toBe(1);
  });

  /**
   * The 2026-08-20 ownership check, and the part most worth pinning: the two sides are spelled
   * differently on purpose — `exclude` is relative to server/<ws>/, `include` is relative to client/ —
   * so the comparison only works if both are normalized to the same repo-relative POSIX form. A
   * regression there would fail closed (noisy), but the passing direction below is what proves the
   * normalization actually lines up rather than never matching.
   */
  it('accepts an excluded test file that client/tsconfig.fulllink.json owns', () => {
    const r = runCoverage(coverageTree({
      testConfig: { exclude: ['test/cross.e2e.test.ts'] },
      fulllinkInclude: ['../server/shared/test/cross.e2e.test.ts'],
    }));
    expect(r.out).toContain('every excluded test file owned by');
    expect(r.code).toBe(0);
  });

  it('fails on an excluded test file that no other program owns', () => {
    const r = runCoverage(coverageTree({
      testConfig: { exclude: ['test/cross.e2e.test.ts'] },
      fulllinkInclude: [],
    }));
    expect(r.out).toContain('without another program owning it');
    expect(r.out).toContain('server/shared/test/cross.e2e.test.ts');
    expect(r.code).toBe(1);
  });

  it('fails on an exclude whose owner file is missing entirely (rather than treating "no owner program" as nothing to check)', () => {
    const r = runCoverage(coverageTree({
      testConfig: { exclude: ['test/cross.e2e.test.ts'] },
      fulllinkInclude: null,
    }));
    expect(r.out).toContain('without another program owning it');
    expect(r.code).toBe(1);
  });

  it('rejects a glob exclude outright — a wildcard makes "is this file checked anywhere" undecidable', () => {
    const r = runCoverage(coverageTree({
      testConfig: { exclude: ['test/*.e2e.test.ts'] },
      fulllinkInclude: [],
    }));
    expect(r.out).toContain('glob excludes are not allowed');
    expect(r.code).toBe(1);
  });

  it('reports the drift and the ownership failure together when both are present', () => {
    const r = runCoverage(coverageTree({
      workspaces: ['shared', 'engine'],
      references: ['shared'],
      testConfig: { exclude: ['test/cross.e2e.test.ts'] },
      fulllinkInclude: [],
    }));
    expect(r.out).toContain('without another program owning it');
    expect(r.out).toContain('gets zero CI type-checking');
    expect(r.code).toBe(1);
  });
});

// ── scripts/checkFileLength.mjs (shared root script) ─────────────────────────────────────────────

const runLen = (root: string, baseline: string, extra: string[] = []) =>
  run(FILELENGTH_SCRIPT, [`--root=${root}`, `--baseline=${join(root, baseline)}`, ...extra]);

describe('checkFileLength.mjs', () => {
  it('passes when every source file is within the limit', () => {
    const root = tree({ 'src/small.ts': lines(10), 'baseline.json': json({}) });
    const r = runLen(root, 'baseline.json');
    expect(r.out).toContain('scanned 1 source files');
    expect(r.out).toContain('OK — no new violations');
    expect(r.code).toBe(0);
  });

  /**
   * The canary. Before this existed, scanning nothing printed "scanned 0 source files, 0 over 500
   * lines" and exited 0 — indistinguishable from a clean repo, so a wrong --root or an exclude rule
   * that grew to match everything would silently retire the gate.
   */
  it('canary: scanning zero source files FAILS instead of reporting a clean run', () => {
    const root = tree({ 'baseline.json': json({}) });
    const r = runLen(root, 'baseline.json');
    expect(r.out).toContain('scanned 0 source files');
    expect(r.out).not.toContain('OK — no new violations');
    expect(r.code).toBe(1);
  });

  it('fails on a new over-limit file that is not in the baseline', () => {
    const root = tree({ 'src/big.ts': lines(600), 'baseline.json': json({}) });
    const r = runLen(root, 'baseline.json');
    expect(r.out).toContain('NEW  src/big.ts: 600 lines');
    expect(r.code).toBe(1);
  });

  it('accepts a known over-limit file at or under its baseline', () => {
    const root = tree({
      'src/big.ts': lines(600),
      'baseline.json': json({ 'src/big.ts': { lines: 601, reason: 'single shared-state root, split tracked separately' } }),
    });
    expect(runLen(root, 'baseline.json').code).toBe(0);
  });

  it('fails when a baselined file grew past its recorded size', () => {
    const root = tree({
      'src/big.ts': lines(600),
      'baseline.json': json({ 'src/big.ts': { lines: 550, reason: 'single shared-state root, split tracked separately' } }),
    });
    const r = runLen(root, 'baseline.json');
    expect(r.out).toContain('GREW src/big.ts: 600 lines, baseline was 550 (+50)');
    expect(r.code).toBe(1);
  });

  it('rejects a baseline entry with a too-short reason (the G3 shape rule) before scanning anything', () => {
    const root = tree({ 'src/big.ts': lines(600), 'baseline.json': json({ 'src/big.ts': { lines: 601, reason: 'big' } }) });
    const r = runLen(root, 'baseline.json');
    expect(r.out).toContain('missing or too-short "reason"');
    expect(r.code).toBe(1);
  });

  it('rejects a baseline entry above the hard cap, reason or not', () => {
    const root = tree({
      'src/huge.ts': lines(900),
      'baseline.json': json({ 'src/huge.ts': { lines: 901, reason: 'genuinely enormous, splitting it is its own task' } }),
    });
    const r = runLen(root, 'baseline.json');
    expect(r.out).toContain('hard cap');
    expect(r.code).toBe(1);
  });

  it('reports a shrunk baseline entry as housekeeping without failing', () => {
    const root = tree({
      'src/big.ts': lines(10),
      'baseline.json': json({ 'src/big.ts': { lines: 601, reason: 'single shared-state root, split tracked separately' } }),
    });
    const r = runLen(root, 'baseline.json');
    expect(r.out).toContain('Housekeeping (non-blocking)');
    expect(r.out).toContain('remove its baseline entry');
    expect(r.code).toBe(0);
  });

  it('skips generated/, test dirs and .d.ts — an over-limit file in any of them is not a violation', () => {
    const root = tree({
      'src/keep.ts': lines(10),
      'src/generated/routes.gen.ts': lines(900),
      'test/huge.test.ts': lines(900),
      'src/types.d.ts': lines(900),
      'baseline.json': json({}),
    });
    const r = runLen(root, 'baseline.json');
    expect(r.out).toContain('scanned 1 source files');
    expect(r.code).toBe(0);
  });

  it('exits 2 on a usage error rather than passing', () => {
    expect(run(FILELENGTH_SCRIPT, []).code).toBe(2);
  });
});
