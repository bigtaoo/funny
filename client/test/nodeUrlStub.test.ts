/**
 * nodeUrlStub.test.ts — pins the contract that lets webpack.config.js alias the npm `url` package to
 * src/platform/stubs/nodeUrl.ts on every target (ASSET_PACKAGING §23).
 *
 * The stub throws. That is behaviour-identical to shipping the real polyfill only while nothing
 * CALLS it, so this test watches both ends of the only path that could:
 *   1. the importer side — `@pixi/utils/lib/url.mjs` is the single module in PixiJS that imports
 *      `url` (2026-10-08 webpack stats, web and mobile graphs alike), and it only re-exposes the three
 *      functions through the deprecated `PIXI.utils.url` getters;
 *   2. the caller side — no PixiJS module other than that file, and no client source, reads
 *      `utils.url`.
 * A PixiJS upgrade that starts using `url` internally, or a client change that reaches for
 * `PIXI.utils.url`, turns this red instead of throwing on a player's screen.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { parse, format, resolve } from '../src/platform/stubs/nodeUrl';

const CLIENT = path.resolve(__dirname, '..');
const PIXI_SCOPE = path.join(CLIENT, 'node_modules/@pixi');
const ALLOWED_IMPORTER = path.join(PIXI_SCOPE, 'utils/lib/url.mjs');

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, ext, out);
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

const requireJs = createRequire(path.join(__dirname, 'nodeUrlStub.test.ts'));
type ConfigFactory = (env: { TARGET: string }, argv: { mode: string }) => { resolve: { alias: Record<string, string> } };
const configFactory = requireJs('../webpack.config.js') as ConfigFactory;

describe('npm `url` → stub alias', () => {
  it.each(['web', 'crazygames', 'mobile', 'wechat', 'web-e2e'])('is applied on the %s target', (target) => {
    const { alias } = configFactory({ TARGET: target }, { mode: 'development' }).resolve;
    expect(alias['url$']?.replace(/\\/g, '/')).toMatch(/src\/platform\/stubs\/nodeUrl\.ts$/);
  });

  it('only @pixi/utils/lib/url.mjs imports `url` among the PixiJS modules webpack bundles', () => {
    const pixiModules = files(PIXI_SCOPE, /\.mjs$/).filter((f) => /[\\/]lib[\\/]/.test(f));
    expect(pixiModules.length).toBeGreaterThan(100); // guards the walk itself
    const importers = pixiModules.filter((f) => /from\s*["']url["']|require\(\s*["']url["']\s*\)/.test(fs.readFileSync(f, 'utf8')));
    expect(importers).toEqual([ALLOWED_IMPORTER]);
  });

  it('nothing in PixiJS or the client reads the deprecated PIXI.utils.url', () => {
    const offenders = [
      ...files(PIXI_SCOPE, /\.mjs$/).filter((f) => /[\\/]lib[\\/]/.test(f) && f !== ALLOWED_IMPORTER),
      // The stub's own header names `PIXI.utils.url` while explaining itself.
      ...files(path.join(CLIENT, 'src'), /\.ts$/).filter((f) => !f.endsWith(`${path.sep}nodeUrl.ts`)),
    ].filter((f) => /utils\s*\.\s*url\b|\{\s*[^}]*\burl\b[^}]*\}\s*=\s*(PIXI\.)?utils\b/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the stub fails loudly rather than returning something subtly wrong', () => {
    expect(() => parse()).toThrow(/nodeUrl\.ts/);
    expect(() => format()).toThrow(/nodeUrl\.ts/);
    expect(() => resolve()).toThrow(/nodeUrl\.ts/);
  });
});
