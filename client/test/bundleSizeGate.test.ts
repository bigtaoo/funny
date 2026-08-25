/**
 * bundleSizeGate.test.ts — mutation tests for `scripts/checkBundleSize.mjs`.
 *
 * Same reasoning as cachePolicyGate.test.ts: this gate exists because the bundle grew ~1.5 MB →
 * 2.08 MB with nothing watching, and a gate that has silently stopped checking reproduces exactly
 * that state while looking green. The three budgets each get a fixture that blows them, plus the
 * cases where the gate's own inputs are wrong (no build, an unlisted metric) — those must be loud
 * failures rather than a pass, because "measured nothing, found nothing over budget" is the shape
 * a broken gate takes.
 *
 * The L0 gate tier is read back out of `dist/index.html`'s `fetchpriority="high"` preloads, so a
 * fixture only needs those link tags to exercise it — which is also what makes the metric
 * drift-proof against `bootManifest.ts` (bootPreloadManifest.test.ts pins the other end).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = path.resolve(__dirname, '../scripts/checkBundleSize.mjs');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-size-gate-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const BUDGETS = {
  'entry.brotli': { maxBytes: 4096, reason: 'fixture' },
  'boot.gate': { maxBytes: 8192, reason: 'fixture' },
  'dist.total': { maxBytes: 1024 * 1024, reason: 'fixture' },
};

/**
 * @param entryBytes    size of the entry chunk BEFORE compression (the gate brotli-compresses it,
 *                      so this is filled with random bytes when it needs to stay incompressible)
 * @param gateAssetBytes size of each of the two fetchpriority=high preloads
 */
function writeDist(opts: { entryBytes?: number; gateAssetBytes?: number; incompressible?: boolean; budgets?: unknown } = {}): { dist: string; budget: string } {
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(dist, 'static'), { recursive: true });
  const entryBytes = opts.entryBytes ?? 512;
  // A seeded LCG, not `i * k % 256`: that has period 256 and brotli models it away to almost
  // nothing, so the "too big" fixture compressed back under budget and the test passed for the
  // wrong reason. Deterministic (no Math.random) but with enough entropy to stay incompressible.
  let seed = 0x9e3779b9;
  const body = opts.incompressible
    ? Buffer.from(Array.from({ length: entryBytes }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return (seed >>> 24) & 0xff;
      }))
    : Buffer.alloc(entryBytes, 0x61);
  fs.writeFileSync(path.join(dist, 'static', 'entry.js'), body);

  const assetBytes = opts.gateAssetBytes ?? 512;
  for (const name of ['a.png', 'b.tao']) fs.writeFileSync(path.join(dist, 'static', name), Buffer.alloc(assetBytes, 0x62));

  fs.writeFileSync(path.join(dist, 'index.html'), [
    '<html><head>',
    '<link rel="preload" href="static/a.png" as="image" crossorigin="anonymous" fetchpriority="high">',
    '<link rel="preload" href="static/b.tao" as="fetch" crossorigin="anonymous" fetchpriority="high">',
    // A background-tier preload, which must NOT count toward boot.gate.
    '<link rel="preload" href="static/c.png" as="image" crossorigin="anonymous" fetchpriority="low">',
    '<script src="static/entry.js"></script>',
    '</head></html>',
  ].join('\n'));
  fs.writeFileSync(path.join(dist, 'static', 'c.png'), Buffer.alloc(64 * 1024, 0x63));

  const budget = path.join(tmp, 'budget.json');
  fs.writeFileSync(budget, JSON.stringify(opts.budgets ?? BUDGETS));
  return { dist, budget };
}

function run(f: { dist: string; budget: string }): { code: number; out: string } {
  const r = spawnSync(process.execPath, [GATE, `--dist=${f.dist}`, `--budget=${f.budget}`], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

describe('checkBundleSize gate', () => {
  it('passes a build inside every budget', () => {
    const r = run(writeDist());
    expect(r.out).toContain('✅');
    expect(r.code).toBe(0);
  });

  it('fails when the entry bundle blows its budget', () => {
    // Incompressible so the brotli step cannot squeeze it back under.
    const r = run(writeDist({ entryBytes: 200_000, incompressible: true }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/entry\.brotli/);
    expect(r.out).toMatch(/OVER BUDGET/);
  });

  // The budget that matters most: this tier is the only one the player literally waits on, and
  // bootManifest's "keep both lists MINIMAL" rule had nothing but a comment behind it.
  it('fails when the L0 blocking tier blows its budget', () => {
    const r = run(writeDist({ gateAssetBytes: 64 * 1024 }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/boot\.gate/);
    expect(r.out).toMatch(/OVER BUDGET/);
  });

  it('counts only the high-priority preloads toward the boot gate', () => {
    // The 64 KB background-tier asset would blow the 8 KB boot budget if it were counted. It is
    // not: the background tier is warmed after the gate resolves and never blocks the loading
    // screen (ASSET_PACKAGING §11.2), so counting it would push people to shrink the wrong thing.
    const r = run(writeDist());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/boot\.gate/);
  });

  it('fails when the whole dist blows its budget', () => {
    const r = run(writeDist({ budgets: { ...BUDGETS, 'dist.total': { maxBytes: 1024, reason: 'fixture' } } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/dist\.total/);
  });

  // "Nothing to measure" must never read as "nothing over budget".
  it('fails loudly when there is no build to measure', () => {
    const budget = path.join(tmp, 'budget.json');
    fs.writeFileSync(budget, JSON.stringify(BUDGETS));
    const r = run({ dist: path.join(tmp, 'nope'), budget });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/run `npm run build:web` first/);
  });

  it('fails when index.html has no high-priority preloads (the plugin silently stopped running)', () => {
    const f = writeDist();
    fs.writeFileSync(path.join(f.dist, 'index.html'), '<html><head><script src="static/entry.js"></script></head></html>');
    const r = run(f);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/PreloadBootAssetsPlugin did not run/);
  });

  it('fails when a measured metric has no budget entry, rather than skipping it', () => {
    const r = run(writeDist({ budgets: { 'entry.brotli': { maxBytes: 4096, reason: 'fixture' } } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no budget entry/);
  });

  it('names the file it could not find when index.html references a missing asset', () => {
    const f = writeDist();
    fs.rmSync(path.join(f.dist, 'static', 'a.png'));
    const r = run(f);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/missing from the build output/);
  });
});
