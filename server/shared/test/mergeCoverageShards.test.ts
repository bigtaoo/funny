// Tests for scripts/mergeCoverageShards.mjs — the step that rebuilds metaserver's and worldsvc's
// coverage-summary.json from their two CI test shards (ci.yml `server-test` matrix, `split`).
//
// Same technique as coverageScripts.test.ts next door: drive the real CLI against throwaway fixture
// trees and assert on what it wrote, because the file it writes is the contract every coverage gate
// downstream reads. What this pins is the reason the script exists — each shard alone covers only
// part of a file, and only the merged hit counts reach the true percentage — plus its one refusal:
// with a shard missing it writes nothing rather than a plausible half-number.
import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'mergeCoverageShards.mjs');

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

const loc = (line: number) => ({ start: { line, column: 0 }, end: { line, column: 10 } });

/** One istanbul file-coverage entry: four one-line statements, two functions, one two-way branch. */
function fileCoverage(path: string, s: number[], f: number[], b: number[]) {
  return {
    path,
    statementMap: Object.fromEntries(s.map((_, i) => [String(i), loc(i + 1)])),
    s: Object.fromEntries(s.map((hits, i) => [String(i), hits])),
    fnMap: Object.fromEntries(f.map((_, i) => [String(i), { name: `fn${i}`, decl: loc(i + 1), loc: loc(i + 1), line: i + 1 }])),
    f: Object.fromEntries(f.map((hits, i) => [String(i), hits])),
    branchMap: { '0': { type: 'if', line: 1, loc: loc(1), locations: [loc(1), loc(2)] } },
    b: { '0': b },
  };
}

function shardTree(shards: Array<Record<string, unknown> | null>): { root: string; dirs: string[]; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'nw-covshard-'));
  trees.push(root);
  const dirs = shards.map((data, i) => {
    const dir = join(root, `shard-${i + 1}`);
    mkdirSync(dir, { recursive: true });
    if (data) writeFileSync(join(dir, 'coverage-final.json'), JSON.stringify(data), 'utf8');
    return dir;
  });
  return { root, dirs, out: join(root, 'merged') };
}

function run(out: string, dirs: string[]) {
  // cwd = repo root: the script resolves the istanbul libraries from server/package.json.
  return spawnSync(process.execPath, [SCRIPT, out, ...dirs], { cwd: REPO_ROOT, encoding: 'utf8' });
}

describe('mergeCoverageShards.mjs', () => {
  const A = '/repo/server/pkg/src/a.ts';

  it('sums the shards’ hits, so the merged summary covers what neither shard covers alone', () => {
    const { dirs, out } = shardTree([
      { [A]: fileCoverage(A, [1, 0, 0, 0], [1, 0], [1, 0]) },
      { [A]: fileCoverage(A, [0, 2, 0, 0], [0, 3], [0, 4]) },
    ]);
    const r = run(out, dirs);
    expect(r.status, r.stderr).toBe(0);

    const summary = JSON.parse(readFileSync(join(out, 'coverage-summary.json'), 'utf8'));
    expect(summary.total.lines).toMatchObject({ total: 4, covered: 2, pct: 50 });
    expect(summary.total.functions).toMatchObject({ total: 2, covered: 2, pct: 100 });
    expect(summary.total.branches).toMatchObject({ total: 2, covered: 2, pct: 100 });
    // Per-file rows keep vitest's json-summary shape: keyed by the path the shards recorded, which
    // is what coverageLib's per-file readers (checkNewFileCoverage) look files up by.
    expect(summary[A].lines).toMatchObject({ total: 4, covered: 2 });
    expect(r.stdout).toContain('2 shards, 1 files');
  });

  it('keeps a file only one shard loaded, at that shard’s numbers', () => {
    const B = '/repo/server/pkg/src/b.ts';
    const { dirs, out } = shardTree([
      { [A]: fileCoverage(A, [1, 1, 1, 1], [1, 1], [1, 1]) },
      { [A]: fileCoverage(A, [0, 0, 0, 0], [0, 0], [0, 0]), [B]: fileCoverage(B, [1, 1, 0, 0], [1, 0], [1, 0]) },
    ]);
    expect(run(out, dirs).status).toBe(0);
    const summary = JSON.parse(readFileSync(join(out, 'coverage-summary.json'), 'utf8'));
    expect(summary[A].lines.pct).toBe(100);
    expect(summary[B].lines.pct).toBe(50);
    expect(summary.total.lines).toMatchObject({ total: 8, covered: 6 });
  });

  it('writes nothing, and still exits 0, when a shard produced no coverage', () => {
    const { dirs, out } = shardTree([{ [A]: fileCoverage(A, [1, 1, 1, 1], [1, 1], [1, 1]) }, null]);
    const r = run(out, dirs);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::');
    // Absent, not half-merged: the coverage gate reports a missing summary as "produced no
    // coverage", where a one-shard summary would pass as a real (and wrong) percentage.
    expect(existsSync(join(out, 'coverage-summary.json'))).toBe(false);
  });

  it('refuses to run without at least one shard', () => {
    const { out } = shardTree([]);
    expect(run(out, []).status).toBe(2);
  });
});
