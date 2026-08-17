/**
 * capacitorStubCompile.test.ts — proves the Capacitor stub swap actually *happens*, by compiling.
 *
 * capacitorStubs.test.ts reads the `NormalModuleReplacementPlugin` table out of webpack.config.js
 * and asserts it says the right thing. That catches a missing or misdirected row, but it cannot
 * catch the table being right and the swap still not taking effect — a webpack upgrade changing when
 * the plugin hooks in, a `resolve.alias` added later that wins over it, or the regex matching the
 * spec we test but not the spec the code actually writes. This file closes that gap the only way
 * available: NormalModuleReplacementPlugin works on webpack's module factory, not on the resolver,
 * so nothing short of a real compilation exercises it.
 *
 * Cost is kept off the default suite's critical path by compiling a 3-line fixture instead of the
 * app: same config object, same plugins, same resolution — one module deep. `transpileOnly` is set
 * because the question here is which *file* each request resolves to, not whether it type-checks
 * (npm run typecheck already owns that, and the fixture is inside its include).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const CLIENT_DIR = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures/capacitorProbe.ts');

// webpack.config.js is outside every tsconfig `include`; webpack itself is loaded the same way so
// both come through one untyped-by-design boundary. Same trick as preloadBootAssetsPlugin.test.ts.
const requireJs = createRequire(path.join(__dirname, 'capacitorStubCompile.test.ts'));
/* eslint-disable @typescript-eslint/no-explicit-any */
const webpack = requireJs('webpack') as any;
const makeConfig = requireJs('../webpack.config.js') as (
  env: { TARGET: string },
  argv: { mode: string },
) => any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let outRoot: string;

beforeAll(() => {
  outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-capacitor-probe-'));
});
afterAll(() => {
  fs.rmSync(outRoot, { recursive: true, force: true });
});

/**
 * Compile the probe fixture through the real config for `target` and return the emitted files.
 *
 * Everything overridden here is emit-side or type-side and provably cannot change which module a
 * request resolves to — the entry (the fixture instead of the app), the output location, source
 * maps, and the ts-loader options. `plugins` is narrowed to the two kinds that participate in
 * resolution/compilation (`NormalModuleReplacementPlugin` — the thing under test — and
 * `DefinePlugin`), dropping the HTML/copy/preload/emit plugins that would otherwise need real
 * templates and asset trees for a test that is not about them.
 *
 * Replacing `output` wholesale also drops wechat's `asyncChunks: false`, deliberately: that is the
 * backstop, and a test of the dependency should not be able to pass because the backstop hid the
 * problem. Without it, a returning split point shows up as a second asset.
 */
async function compile(target: string): Promise<{ assets: string[]; resources: string[] }> {
  const cfg = makeConfig({ TARGET: target }, { mode: 'development' });
  const outDir = path.join(outRoot, target);
  cfg.entry = FIXTURE;
  cfg.output = { path: outDir, filename: 'probe.js' };
  cfg.devtool = false;
  cfg.plugins = cfg.plugins.filter((p: { constructor: { name: string } }) =>
    p?.constructor?.name === 'NormalModuleReplacementPlugin' || p?.constructor?.name === 'DefinePlugin');
  cfg.module.rules = [{
    test: /\.ts$/,
    use: {
      loader: 'ts-loader',
      // configFile explicitly: ts-loader otherwise searches upward from the file it is compiling,
      // which for a stub under src/ or a package under node_modules can find a foreign tsconfig.
      options: { transpileOnly: true, configFile: path.join(CLIENT_DIR, 'tsconfig.json') },
    },
  }];
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webpack(cfg, (err: Error | null, stats: any) => {
      if (err) return reject(err);
      if (stats.hasErrors()) {
        return reject(new Error((stats.toJson().errors ?? []).map((e: { message: string }) => e.message).join('\n')));
      }
      resolve({
        assets: stats.compilation.getAssets().map((a: { name: string }) => a.name).sort(),
        // The absolute file each request resolved to — the ground truth about the swap, rather than
        // sniffing webpack's generated text for markers whose shape changes with mode/minification.
        resources: [...stats.compilation.modules]
          .map((m: { resource?: string }) => m.resource)
          .filter((r): r is string => !!r)
          .map((r) => r.replace(/\\/g, '/')),
      });
    });
  });
}

const STUB_DIR = 'src/platform/stubs/';
const CAPACITOR_PKG = 'node_modules/@capacitor/';

describe('the Capacitor swap survives a real compilation', () => {
  it.each(['web', 'crazygames', 'wechat', 'web-e2e'])('%s resolves both packages to the stubs', async (target) => {
    const { resources } = await compile(target);
    expect(resources.filter((r) => r.includes(STUB_DIR)).map((r) => r.slice(r.indexOf(STUB_DIR))).sort())
      .toEqual([`${STUB_DIR}capacitorCore.ts`, `${STUB_DIR}localNotifications.ts`]);
    // The point of the exercise: not one byte of either package in the graph.
    expect(resources.filter((r) => r.includes(CAPACITOR_PKG))).toEqual([]);
  }, 60_000);

  it('wechat emits one file even with the asyncChunks backstop off', async () => {
    // Closes the loop on the stray 90.pixigame.js: with the plugin's `web: () => import('./web')`
    // out of the graph there is no split point to inline in the first place, so this holds without
    // the `asyncChunks:false` the output override drops. Verified to fail if the swap is removed.
    expect((await compile('wechat')).assets).toEqual(['probe.js']);
  }, 60_000);

  it('mobile resolves both packages to the real thing', async () => {
    const { resources } = await compile('mobile');
    expect(resources.some((r) => r.endsWith(`${CAPACITOR_PKG}core/dist/index.js`))).toBe(true);
    expect(resources.some((r) => r.includes(`${CAPACITOR_PKG}local-notifications/`))).toBe(true);
    expect(resources.filter((r) => r.includes(STUB_DIR))).toEqual([]);
  }, 60_000);
});
