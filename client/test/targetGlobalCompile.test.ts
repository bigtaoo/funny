/**
 * targetGlobalCompile.test.ts — proves the build target reaches the running code, by compiling and
 * then *running* the result.
 *
 * `TARGET` is how three separate systems answer "which platform am I?": the X-NW-Platform header
 * that picks the recharged-pool bucket (ADR-020, net/ApiClient/core.ts), the analytics platform
 * dimension, and the `platform` field on every anomaly log line. All three read
 * `globalThis.TARGET`, and the DefinePlugin row that was supposed to supply it was keyed `TARGET`
 * — which substitutes a free variable and leaves a member expression alone. So the value was
 * `undefined` everywhere and all three answered 'web' from *every* build, wechat and crazygames
 * included. Nothing threw, nothing looked broken, and no test could see it: the config said the
 * right thing (a config-reading assertion passes either way) and unit tests set `globalThis.TARGET`
 * themselves, which is the one context where reading it works.
 *
 * Hence a compile probe, in the shape capacitorStubCompile.test.ts already established: the
 * fixture is three lines with no imports, so the emitted bundle can be required in Node and asked
 * what the shipped expression actually evaluates to. Grepping the output text would not do — the
 * question is the value, and DefinePlugin's substitution is exactly what the text does not reveal
 * once a bundler has renamed things around it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const CLIENT_DIR = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures/targetGlobalProbe.ts');

// webpack.config.js is outside every tsconfig `include`; webpack itself comes through the same
// untyped-by-design boundary. Same trick as capacitorStubCompile.test.ts.
const requireJs = createRequire(path.join(__dirname, 'targetGlobalCompile.test.ts'));
/* eslint-disable @typescript-eslint/no-explicit-any */
const webpack = requireJs('webpack') as any;
const makeConfig = requireJs('../webpack.config.js') as (
  env: { TARGET: string },
  argv: { mode: string },
) => any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let outRoot: string;
beforeAll(() => { outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-target-probe-')); });
afterAll(() => { fs.rmSync(outRoot, { recursive: true, force: true }); });

/** Compile the fixture through the real config for `target`, then require the bundle and read it. */
async function compiledProbe(target: string): Promise<{ raw: string; viaAppConstants: string }> {
  const cfg = makeConfig({ TARGET: target }, { mode: 'development' });
  const outDir = path.join(outRoot, target);
  cfg.entry = FIXTURE;
  // commonjs2 so Node can require the emitted bundle; `target: 'node'` so webpack does not wrap it
  // in browser-only runtime bootstrapping. Neither touches DefinePlugin, which is the thing tested.
  cfg.output = { path: outDir, filename: 'probe.js', library: { type: 'commonjs2' } };
  cfg.target = 'node';
  cfg.devtool = false;
  // Only DefinePlugin is kept: the rest need real templates and asset trees, and none of them
  // participate in constant substitution.
  cfg.plugins = cfg.plugins.filter((p: { constructor: { name: string } }) => p?.constructor?.name === 'DefinePlugin');
  cfg.module.rules = [{
    test: /\.ts$/,
    use: {
      loader: 'ts-loader',
      options: { transpileOnly: true, configFile: path.join(CLIENT_DIR, 'tsconfig.json') },
    },
  }];
  await new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webpack(cfg, (err: Error | null, stats: any) => {
      if (err) return reject(err);
      if (stats.hasErrors()) {
        return reject(new Error((stats.toJson().errors ?? []).map((e: { message: string }) => e.message).join('\n')));
      }
      resolve();
    });
  });
  const bundlePath = path.join(outDir, 'probe.js');
  return requireJs(bundlePath) as { raw: string; viaAppConstants: string };
}

describe('globalThis.TARGET survives the build', () => {
  // The two targets that are not 'web' are the whole point: they are the ones that were silently
  // mislabelling themselves, and 'web' is the value a broken substitution also produces.
  it.each(['crazygames', 'wechat', 'mobile', 'web'])(
    'REGRESSION: a %s build reports that target at runtime, not undefined',
    async (target) => {
      expect((await compiledProbe(target)).raw).toBe(target);
    },
    60_000,
  );

  // The case above reads an expression the fixture spells out itself, so it proves DefinePlugin
  // substitutes this *shape* — not that the shape is still what the shipped code writes. Compiling
  // the real clientPlatformName() closes that.
  //
  // What that buys, measured rather than assumed (2026-09-04, by mutating appConstants and
  // re-running): webpack's parser is more forgiving than the key suggests — `globalThis['TARGET']`
  // and even `const g = globalThis; g.TARGET` are both still substituted, because it follows
  // string-literal member access and simple const aliases. What it cannot follow is the read
  // leaving the expression: factor the three duplicated readers into `read(globalThis, 'TARGET')`
  // — the obvious dedupe, and the next plausible edit here — and the value silently reverts to
  // undefined. That mutation fails these cases and passes the ones above, which is the whole
  // reason both halves exist.
  it.each([
    ['crazygames', 'crazygames'],
    ['wechat', 'wechat'],
    ['web', 'web'],
    // mobile is not a platform *name*: it reuses the web bundle and answers 'web' by design, with
    // the shell identified separately by Capacitor (net/ApiClient/core.ts's requestPlatformHeader).
    // Pinned so that intent stays visible rather than looking like the bug this file exists for.
    ['mobile', 'web'],
  ])('clientPlatformName() in a %s build answers %s', async (target, expected) => {
    expect((await compiledProbe(target)).viaAppConstants).toBe(expected);
  }, 60_000);
});
