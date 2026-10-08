/**
 * hiresSplit.test.ts — the H5/native art split (ASSET_PACKAGING §9 + §23) as checked invariants.
 *
 * The `.hires` swap is silent by design: call sites import `foo.png`, the `mobile` build quietly
 * resolves `foo.hires.png`. Nothing at runtime can tell a correct split from a broken one — a base
 * file that was accidentally overwritten with the original just costs bytes, and a `.hires` file that
 * was accidentally overwritten with the downscaled copy silently drops the native app to H5 quality.
 * So the relationship between each pair is pinned here, from the PNG headers alone:
 *   1. every `.hires` sibling is strictly larger in pixels than its base, with the same aspect ratio
 *      (the base is a resize of it, not a different picture or a crop), and the base is smaller in bytes;
 *   2. the sets art/scripts/deriveH5ArtVariants.mjs manages are capped where its header says;
 *   3. the three PWA icons, which CopyPlugin copies rather than imports (so the module-replacement swap
 *      cannot reach them), take the `.hires` original on `mobile` and the base everywhere else.
 * assetsAreShipped.test.ts separately checks every `.hires` file has its base file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const CLIENT = path.resolve(__dirname, '..');
const HIRES = /\.hires\.png$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (HIRES.test(e.name)) out.push(p);
  }
  return out;
}

/** Width/height straight out of the IHDR chunk. */
function pngSize(file: string): { w: number; h: number } {
  const b = fs.readFileSync(file);
  expect(b.subarray(12, 16).toString('latin1'), file).toBe('IHDR');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const rel = (f: string): string => path.relative(CLIENT, f).replace(/\\/g, '/');
const PAIRS = [...walk(path.join(CLIENT, 'src/assets')), ...walk(path.join(CLIENT, 'public'))]
  .map((hires) => ({ hires, base: hires.replace(HIRES, '.png') }));

describe('.hires / base pairs', () => {
  it('finds the split assets (guards the walk itself)', () => {
    // logo + 6 unit card exports + 32 bust portraits + 3 PWA icons, as of 2026-10-08.
    expect(PAIRS.length).toBeGreaterThanOrEqual(42);
  });

  it.each(PAIRS.map((p) => [rel(p.hires), p]))('%s is the larger original of its base file', (_name, { hires, base }) => {
    const hi = pngSize(hires);
    const lo = pngSize(base);
    expect(fs.statSync(base).size).toBeLessThan(fs.statSync(hires).size);
    expect(lo.w).toBeLessThanOrEqual(hi.w);
    expect(lo.h).toBeLessThanOrEqual(hi.h);
    // Same picture, resized: aspect agrees to within one pixel of rounding on the short side.
    expect(Math.abs(lo.h - (hi.h * lo.w) / hi.w)).toBeLessThanOrEqual(1);
    // Only the PWA icons keep their size (palette re-encode only); everything else is downscaled.
    if (!rel(hires).startsWith('public/')) expect(lo.w * lo.h).toBeLessThan(hi.w * hi.h);
  });

  it('unit card full art ships at most 1400 px on its long edge to H5', () => {
    for (const { base } of PAIRS.filter((p) => /src\/assets\/units\/[^/]+$/.test(rel(p.base)))) {
      const { w, h } = pngSize(base);
      expect(Math.max(w, h), rel(base)).toBe(1400);
    }
  });

  it('bust portraits ship 384 px wide to H5', () => {
    const busts = PAIRS.filter((p) => rel(p.base).startsWith('src/assets/avatars/'));
    expect(busts.length).toBe(32);
    for (const { base } of busts) expect(pngSize(base).w, rel(base)).toBe(384);
  });
});

describe('PWA icons follow the same split through CopyPlugin', () => {
  const requireJs = createRequire(path.join(__dirname, 'hiresSplit.test.ts'));
  type Pattern = { from: string; to?: string };
  type ConfigFactory = (env: { TARGET: string }, argv: { mode: string }) => { plugins: unknown[] };
  const configFactory = requireJs('../webpack.config.js') as ConfigFactory;
  const copied = (target: string): Pattern[] =>
    configFactory({ TARGET: target }, { mode: 'development' }).plugins
      .filter((p) => (p as { constructor?: { name?: string } }).constructor?.name === 'CopyPlugin')
      .flatMap((p) => (p as { patterns: Pattern[] }).patterns);
  const ICONS = ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

  it('mobile copies each .hires original under the base name', () => {
    const patterns = copied('mobile');
    for (const icon of ICONS) {
      expect(patterns).toContainEqual({ from: `public/${icon.replace(/\.png$/, '.hires.png')}`, to: icon });
    }
  });

  it.each(['web', 'crazygames'])('%s copies the compressed base file', (target) => {
    const froms = copied(target).map((p) => p.from);
    for (const icon of ICONS) {
      expect(froms).toContain(`public/${icon}`);
      expect(froms.some((f) => f.includes('.hires.'))).toBe(false);
    }
  });
});
