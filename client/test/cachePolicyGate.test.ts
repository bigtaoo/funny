/**
 * cachePolicyGate.test.ts — mutation tests for `scripts/checkCachePolicy.mjs`.
 *
 * A gate nobody has watched fail is not a gate. This project has already paid for that lesson
 * twice: the cache policy itself was "configured" in two places that production never read
 * (ASSET_PACKAGING §13.1), and the SLG atlas pipeline accumulated three instances of the same
 * silent sharp bug because it had no assertions at all. The gate that now guards the first of
 * those is itself a script that could quietly stop checking — so each rule it enforces gets a
 * fixture that breaks exactly that rule, and the test asserts the gate says so.
 *
 * Fixtures are tiny hand-built `dist/` trees rather than real builds: what is under test is the
 * gate's reading of `_headers`, not webpack. (`test/bundleSizeGate.test.ts` does the same for the
 * size budget.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = path.resolve(__dirname, '../scripts/checkCachePolicy.mjs');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-cache-gate-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A dist/ tree that satisfies every rule — each test then breaks exactly one thing. */
function writeDist(opts: { headers?: string; entry?: string; extraFiles?: Record<string, string> } = {}): string {
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(dist, 'static'), { recursive: true });
  const entry = opts.entry ?? 'static/abc123.js';
  fs.mkdirSync(path.dirname(path.join(dist, entry)), { recursive: true });
  fs.writeFileSync(path.join(dist, entry), '// bundle');
  fs.writeFileSync(path.join(dist, 'static', 'def456.png'), 'png');
  fs.writeFileSync(path.join(dist, 'index.html'), `<html><head><script src="${entry}"></script></head></html>`);
  fs.writeFileSync(path.join(dist, 'version.json'), '{"v":"1"}');
  fs.writeFileSync(path.join(dist, '_headers'), opts.headers ?? [
    '/static/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/index.html',
    '  Cache-Control: no-cache, must-revalidate',
    '/version.json',
    '  Cache-Control: no-cache, must-revalidate',
  ].join('\n'));
  for (const [rel, body] of Object.entries(opts.extraFiles ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), body);
  }
  return dist;
}

function run(dist: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [GATE, `--dist=${dist}`], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

describe('checkCachePolicy gate', () => {
  it('passes a correctly configured build', () => {
    const r = run(writeDist());
    expect(r.out).toContain('✅');
    expect(r.code).toBe(0);
  });

  it('fails when _headers is missing entirely (the state production was actually in)', () => {
    const dist = writeDist();
    fs.rmSync(path.join(dist, '_headers'));
    const r = run(dist);
    expect(r.code).toBe(1);
    expect(r.out).toContain('_headers is missing');
  });

  // The exact regression: index.html and version.json had rules, hashed files had none, so they
  // fell through to Cloudflare's `max-age=0, must-revalidate` default.
  it('fails when the hashed files have no rule of their own', () => {
    const r = run(writeDist({ headers: ['/index.html', '  Cache-Control: no-cache, must-revalidate'].join('\n') }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no _headers rule sets its Cache-Control/);
  });

  it('fails when the hashed rule is not actually immutable', () => {
    const r = run(writeDist({ headers: ['/static/*', '  Cache-Control: public, max-age=600'].join('\n') }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/does not serve it immutable/);
  });

  // THE invariant: Cloudflare comma-joins duplicate headers instead of letting the narrower rule
  // win, so this shape emits `...immutable, no-cache, must-revalidate` on index.html.
  it('fails on overlapping rules, even though the narrow one "looks" like an override', () => {
    const r = run(writeDist({ headers: [
      '/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '/index.html',
      '  Cache-Control: no-cache, must-revalidate',
    ].join('\n') }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/matches 2 Cache-Control rules/);
    expect(r.out).toMatch(/COMMA-JOINS/);
  });

  it('fails when index.html is served immutable', () => {
    const r = run(writeDist({ headers: [
      '/static/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '/index.html',
      '  Cache-Control: public, max-age=31536000, immutable',
      '/version.json',
      '  Cache-Control: no-cache, must-revalidate',
    ].join('\n') }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/pins every player to a dead bundle URL/);
  });

  it('fails when contenthashed output escapes the static/ dir', () => {
    // Reverting output.filename to `[contenthash].js` puts the bundle back at the root, where the
    // only way to cover it is a `/*` rule that then also covers index.html.
    const r = run(writeDist({ entry: 'abc123.js' }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/outside \/static\//);
  });

  it('fails when a file lands under static/ that no rule covers', () => {
    const r = run(writeDist({ headers: [
      '/static/js/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '/index.html',
      '  Cache-Control: no-cache, must-revalidate',
      '/version.json',
      '  Cache-Control: no-cache, must-revalidate',
    ].join('\n') }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no _headers rule sets its Cache-Control/);
  });

  // Cloudflare allows one splat per pattern. Emulating a two-splat pattern would mean guessing at
  // behaviour that differs in production, so the gate reports it instead of quietly matching.
  it('reports a pattern with more than one splat rather than guessing', () => {
    const r = run(writeDist({ headers: ['/static/*/*', '  Cache-Control: public, max-age=31536000, immutable'].join('\n') }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/splats; Cloudflare allows one/);
  });

  it('ignores comments and blank lines', () => {
    const r = run(writeDist({ headers: [
      '# hashed forever',
      '',
      '/static/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '',
      '/index.html',
      '  Cache-Control: no-cache, must-revalidate',
      '/version.json',
      '  Cache-Control: no-cache, must-revalidate',
    ].join('\n') }));
    expect(r.out).toContain('✅');
    expect(r.code).toBe(0);
  });

  // Non-hashed root files (favicons, legal pages) intentionally have NO rule and inherit
  // Cloudflare's revalidating default — they are tiny, change rarely, and must propagate promptly.
  it('does not demand a rule for fixed-name root files like favicons', () => {
    const r = run(writeDist({ extraFiles: { 'favicon-32.png': 'png', 'terms.html': '<html/>' } }));
    expect(r.out).toContain('✅');
    expect(r.code).toBe(0);
  });
});
