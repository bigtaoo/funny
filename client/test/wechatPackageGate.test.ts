/**
 * wechatPackageGate.test.ts — mutation tests for `scripts/checkWechatPackage.mjs`.
 *
 * The gate exists because `client/wechatgame/` is entirely gitignored: its bundle and its `cdn/`
 * assets can come from different builds and nothing says so. On 2026-09-01 they did — a bundle
 * refreshed by hand next to July's assets — and WeChat DevTools answered with a black screen and
 * no attributable error.
 *
 * A gate nobody has watched fail is not a gate, so each rule gets a fixture that breaks exactly
 * that rule. Fixtures are hand-built `wechatgame/` trees, not real builds: what is under test is
 * the gate's reading of the directory, not webpack. (`test/cachePolicyGate.test.ts` and
 * `test/bundleSizeGate.test.ts` do the same for their own gates.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = path.resolve(__dirname, '../scripts/checkWechatPackage.mjs');

const HASH_A = 'a1b2c3d4e5f60718293a.png';
const HASH_B = 'ffeeddccbbaa99887766.tao';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-wechat-gate-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A wechatgame/ tree that satisfies every rule — each test then breaks exactly one thing. */
function writePkg(opts: {
  bundle?: string;
  gameJs?: string | null;
  gameJson?: string | null;
  assets?: string[];
  extraFiles?: Record<string, string>;
} = {}): string {
  const pkg = path.join(tmp, 'wechatgame');
  fs.mkdirSync(path.join(pkg, 'cdn'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'pixigame.js'),
    opts.bundle ?? `(()=>{const a="cdn/${HASH_A}",b="cdn/${HASH_B}";console.log(a,b);})();`,
  );
  if (opts.gameJs !== null) fs.writeFileSync(path.join(pkg, 'game.js'), opts.gameJs ?? "require('./pixigame.js');");
  if (opts.gameJson !== null) fs.writeFileSync(path.join(pkg, 'game.json'), opts.gameJson ?? '{"deviceOrientation":"portrait"}');
  for (const name of opts.assets ?? [HASH_A, HASH_B]) fs.writeFileSync(path.join(pkg, 'cdn', name), 'bytes');
  for (const [rel, body] of Object.entries(opts.extraFiles ?? {})) fs.writeFileSync(path.join(pkg, rel), body);
  return pkg;
}

function run(pkg: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [GATE, `--pkg=${pkg}`], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

describe('checkWechatPackage gate', () => {
  it('passes on a complete package', () => {
    const { code, out } = run(writePkg());
    expect(code).toBe(0);
    expect(out).toContain('2 baked asset URLs all present');
  });

  // ── the black screen this gate was written for ─────────────────────────────
  it('fails when a baked asset URL has no file — the 2026-09-01 black screen', () => {
    const { code, out } = run(writePkg({ assets: [HASH_A] })); // HASH_B never emitted
    expect(code).toBe(1);
    expect(out).toContain('1 of 2 baked asset URLs have no file');
    expect(out).toContain(HASH_B);
  });

  it('names the actual remedy — rebuild in THIS checkout, not copy the bundle over', () => {
    const { out } = run(writePkg({ assets: [] }));
    expect(out).toContain('npm run build:wechat');
    expect(out).toContain('worktree');
  });

  it('fails the same way when cdn/ is absent entirely', () => {
    const pkg = writePkg();
    fs.rmSync(path.join(pkg, 'cdn'), { recursive: true, force: true });
    const { code, out } = run(pkg);
    expect(code).toBe(1);
    expect(out).toContain('2 of 2 baked asset URLs have no file');
  });

  it('checks absolute CDN urls too (plan A builds bake the whole host in)', () => {
    const bundle = `(()=>{const a="https://cdn.example.com/cdn/${HASH_A}";console.log(a);})();`;
    const { code, out } = run(writePkg({ bundle, assets: [] }));
    expect(code).toBe(1);
    expect(out).toContain(HASH_A);
  });

  it('collapses a long missing list instead of printing hundreds of lines', () => {
    const names = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(20, '0')}.png`);
    const bundle = `(()=>{${names.map((n, i) => `const a${i}="cdn/${n}";`).join('')}})();`;
    const { code, out } = run(writePkg({ bundle, assets: [] }));
    expect(code).toBe(1);
    expect(out).toContain('… and 18 more'); // 30 missing, 12 listed
  });

  // ── the shell ──────────────────────────────────────────────────────────────
  it('fails when the bundle itself is missing, and says how to make one', () => {
    const pkg = writePkg();
    fs.rmSync(path.join(pkg, 'pixigame.js'));
    const { code, out } = run(pkg);
    expect(code).toBe(1);
    expect(out).toContain('npm run build:wechat');
  });

  it('fails when game.js is missing', () => {
    const { code, out } = run(writePkg({ gameJs: null }));
    expect(code).toBe(1);
    expect(out).toContain('game.js is missing');
  });

  it('fails when game.js requires something other than the bundle', () => {
    const { code, out } = run(writePkg({ gameJs: "require('./old-bundle.js');" }));
    expect(code).toBe(1);
    expect(out).toContain('load nothing');
  });

  it('fails when game.json is missing or unparseable', () => {
    expect(run(writePkg({ gameJson: null })).code).toBe(1);
    const broken = run(writePkg({ gameJson: '{"deviceOrientation":' }));
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('not valid JSON');
  });

  // ── the single-bundle invariant, checked on the output this time ───────────
  it('fails on a stray async chunk beside the bundle (asyncChunks:false lost)', () => {
    const { code, out } = run(writePkg({ extraFiles: { '90.pixigame.js': '// chunk' } }));
    expect(code).toBe(1);
    expect(out).toContain('90.pixigame.js');
  });

  // ── the one thing it must NOT do ───────────────────────────────────────────
  it('does not fail on unreferenced leftovers — clean:false keeps every earlier build\'s files', () => {
    const { code, out } = run(writePkg({ assets: [HASH_A, HASH_B, 'deadbeefdeadbeefdead.png'] }));
    expect(code).toBe(0);
    expect(out).toContain('1 unreferenced file(s)');
  });
});
