// Tests for scripts/checkUnreachableModules.mjs — the reachability gate added 2026-08-20, right
// after tools/animator/src turned out to be carrying a complete pre-refactor copy of itself (11
// flat modules + 2 `export {}` shells, 1424 lines, zero coverage) that nothing had imported for
// months.
//
// Third member of the family in guardScripts.test.ts / coverageScripts.test.ts, same reasoning and
// same technique: driven through the real CLI (spawn node, assert exit code + stdout) against
// throwaway fixture trees, because the exit code is the contract CI consumes.
//
// This one needs its own tests more than most, because its failure mode is subtle rather than
// absent. A module resolver that is merely *approximately* right reports a live file as dead (false
// alarm → someone mutes the gate) or a dead file as live (silence → the gate is decoration). The
// candidate-order case below is the exact shape that hid the animator graph: its dead `renderer.ts`
// imported `./skeleton`, which resolves to the dead flat `src/skeleton.ts`, NOT the live
// `src/skeleton/Skeleton.ts` — so the dead set kept each other reachable and looked alive from the
// inside. A resolver that tried `skeleton/index.ts` first would have called the whole graph live.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', '..', '..', 'scripts', 'checkUnreachableModules.mjs');
const TOOLS_WRAPPER = resolve(HERE, '..', '..', '..', 'tools', 'scripts', 'checkUnreachableModules.mjs');
const TOOLS_DIR = resolve(HERE, '..', '..', '..', 'tools');

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** Materializes `{ 'src/a.ts': "contents" }` into a fresh temp dir and returns its path. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'reach-'));
  trees.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function run(root: string, extraArgs: string[] = []) {
  const r = spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...extraArgs], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('checkUnreachableModules.mjs', () => {
  it('passes when every src file is reachable from the entry', () => {
    const root = tree({
      'src/index.ts': `import { a } from './a';\na();\n`,
      'src/a.ts': `export const a = () => {};\n`,
    });
    const { status, out } = run(root);
    expect(status).toBe(0);
    expect(out).toContain('OK — all 2 source file(s)');
  });

  it('reports a self-closing dead graph — the animator case', () => {
    // Mirrors the real shape exactly: live code goes index -> skeleton/Skeleton.ts, while the dead
    // pair keeps ITSELF reachable via './skeleton' resolving to the flat twin.
    const root = tree({
      'src/index.ts': `import { Skeleton } from './skeleton/Skeleton';\nSkeleton;\n`,
      'src/skeleton/Skeleton.ts': `export class Skeleton {}\n`,
      'src/renderer.ts': `import { BONE_MAP } from './skeleton';\nBONE_MAP;\n`,
      'src/skeleton.ts': `import type { BoneDef } from './types';\nexport const BONE_MAP: BoneDef = {} as BoneDef;\n`,
      'src/types.ts': `export interface BoneDef { id: string }\n`,
    });
    const { status, out } = run(root);
    expect(status).toBe(1);
    expect(out).toContain('3 unreachable source file(s)');
    for (const dead of ['src/renderer.ts', 'src/skeleton.ts', 'src/types.ts']) {
      expect(out).toContain(`- ${dead}`);
    }
    // The live twin must NOT be swept up with its dead namesake — that is the mis-delete risk.
    expect(out).not.toContain('src/skeleton/Skeleton.ts');
  });

  it('resolves ./x to x.ts BEFORE x/index.ts (the order that makes the dead graph visible)', () => {
    // Both exist. tsc picks m.ts, so m/index.ts is what nothing imports. Flip the order in the
    // script and this assertion inverts — which is precisely how a dead graph reads as live.
    const root = tree({
      'src/index.ts': `import './m';\n`,
      'src/m.ts': `export const m = 1;\n`,
      'src/m/index.ts': `export const viaIndex = 1;\n`,
    });
    const { status, out } = run(root);
    expect(status).toBe(1);
    expect(out).toContain('- src/m/index.ts');
    expect(out).not.toContain('- src/m.ts');
  });

  it('follows x/index.ts when the flat twin does not exist', () => {
    const root = tree({
      'src/index.ts': `import './m';\n`,
      'src/m/index.ts': `export const m = 1;\n`,
    });
    expect(run(root).status).toBe(0);
  });

  it('follows non-relative specifiers through tsconfig baseUrl (= src)', () => {
    const root = tree({
      'src/index.ts': `import type { T } from 'core/types';\nexport type U = T;\n`,
      'src/core/types.ts': `export interface T { a: string }\n`,
    });
    expect(run(root).status).toBe(0);
  });

  it('counts type-only and multi-line imports as reachability', () => {
    // `import type` is erased at runtime but is still a reference; and the multi-line list is the
    // regex trap — a `.`-based pattern stops at the newline and reports b.ts as dead.
    const root = tree({
      'src/index.ts': `import type { A } from './a';\nimport {\n  b,\n  c,\n} from './b';\nb; c;\nexport type X = A;\n`,
      'src/a.ts': `export interface A { v: number }\n`,
      'src/b.ts': `export const b = 1;\nexport const c = 2;\n`,
    });
    expect(run(root).status).toBe(0);
  });

  it('counts dynamic import() and require() as reachability', () => {
    const root = tree({
      'src/index.ts': `void import('./lazy');\nconst r = require('./legacy');\nr;\n`,
      'src/lazy.ts': `export const l = 1;\n`,
      'src/legacy.ts': `module.exports = 1;\n`,
    });
    expect(run(root).status).toBe(0);
  });

  it('treats test files as roots, and never audits them', () => {
    // A module only a test imports is not dead code, so it must not fail this gate; the test file
    // itself is a root, never a subject.
    const root = tree({
      'src/index.ts': `export const main = 1;\n`,
      'src/pure.ts': `export const pure = () => 42;\n`,
      'test/pure.test.ts': `import { pure } from '../src/pure';\npure();\n`,
    });
    const { status, out } = run(root);
    expect(status).toBe(0);
    expect(out).toContain('OK — all 2 source file(s)');
  });

  it('needs --extra-root for a sibling product tree outside src/, and says so without it', () => {
    // animator's runtime/StickmanRuntime.ts: no entry imports it, so everything it pulls in reads
    // as unreachable until runtime/ is declared a root. Both directions pinned, because a wrong
    // answer here is a false alarm big enough to get the whole gate muted.
    const files = {
      'src/index.ts': `export const main = 1;\n`,
      'src/shared.ts': `export const shared = 1;\n`,
      'runtime/Runtime.ts': `import { shared } from '../src/shared';\nshared;\n`,
    };
    const without = run(tree(files));
    expect(without.status).toBe(1);
    expect(without.out).toContain('- src/shared.ts');

    const withRoot = run(tree(files), ['--extra-root=runtime']);
    expect(withRoot.status).toBe(0);
  });

  it('ignores .d.ts files — nothing imports ambient declarations, but tsc needs them', () => {
    const root = tree({
      'src/index.ts': `export const main = 1;\n`,
      'src/globals.d.ts': `interface Window { nwDesktop?: unknown }\n`,
    });
    expect(run(root).status).toBe(0);
  });

  it('ignores unresolvable and out-of-package specifiers instead of crashing', () => {
    const root = tree({
      'src/index.ts': `import * as PIXI from 'pixi.js';\nimport { e } from '@nw/engine';\nimport { x } from '../../elsewhere';\nPIXI; e; x;\n`,
    });
    expect(run(root).status).toBe(0);
  });

  it('fails on a missing entry rather than blaming every file', () => {
    // The likeliest way this gate rots: a renamed entry. Without this it would print "everything is
    // unreachable", which reads as a broken gate and gets switched off.
    const root = tree({ 'src/main.ts': `export const main = 1;\n` });
    const { status, out } = run(root);
    expect(status).toBe(1);
    expect(out).toContain('entry not found');
    expect(out).not.toContain('unreachable source file(s)');
  });

  it('canary: fails when it scanned 0 source files', () => {
    // Same canary the sibling guards carry: "scanned nothing" and "found nothing wrong" print the
    // same OK otherwise, so a --src pointing somewhere empty would pass by doing nothing.
    // The entry is passed explicitly and DOES exist, because otherwise the missing-entry check
    // (asserted above) fires first and this fixture would prove that instead.
    const root = tree({
      'src/index.ts': `export const main = 1;\n`,
      'empty/notes.md': `no source here\n`,
    });
    const { status, out } = run(root, ['--src=empty', '--entry=src/index.ts']);
    expect(status).toBe(1);
    expect(out).toContain('scanned 0 source files');
  });

  it('exits 2 on a missing --root (usage error, not a pass)', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe('tools/scripts/checkUnreachableModules.mjs (the real wrapper)', () => {
  // Integration: the fixtures above prove the walker, this proves the config it is pointed at.
  // A wrapper listing the wrong package names or forgetting animator's --extra-root would pass
  // every unit test above and still gate nothing real.
  it('reports every tool package reachable', () => {
    const r = spawnSync(process.execPath, [TOOLS_WRAPPER], { cwd: TOOLS_DIR, encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    for (const pkg of ['animator', 'level-editor', 'map-editor', 'ops', 'vfx-editor', 'desktop-shell']) {
      expect(out).toContain(`${pkg}: OK`);
    }
    expect(out).toContain('runtime/');
    // desktop-shell joined 2026-08-21 and is the only package with custom --entry roots: Electron
    // loads its two preloads by path string, so they are roots rather than imports. Asserting the
    // roots by name is the point — a wrapper that dropped them would report the preloads (and
    // whatever only they import) as unreachable, and a wrapper that dropped src/main.ts would
    // report almost the whole package, i.e. both directions fail loudly rather than silently.
    expect(out).toContain('src/main.ts, src/preload.ts, src/preloadSidebar.ts');
    expect(r.status).toBe(0);
  });
});
