/**
 * capacitorStubs.test.ts — guards the "no Capacitor in non-mobile bundles" contract
 * (webpack.config.js NormalModuleReplacementPlugin table, ASSET_PACKAGING §4.0).
 *
 * The contract is invisible at runtime: the stubs only ever replace code that is unreachable on
 * web/crazygames/wechat anyway, so getting it wrong costs bytes (or, once, a stray wechat chunk)
 * rather than behaviour — nothing in the game breaks, no test goes red, and the regression is only
 * visible to someone diffing bundle sizes. Hence a test on the *build wiring* instead. It pins the
 * three ways this drifts:
 *   1. a native-only package joins the shared graph without a stub → back to shipping dead plugin
 *      code on three targets;
 *   2. a stub is swapped into the `mobile` build too → iOS silently stops scheduling reminders,
 *      which is the one failure here that a player would notice;
 *   3. a call site starts using a plugin method the stub does not define → `x is not a function`
 *      on web only.
 *
 * Sibling to wechatSingleBundle.test.ts, which reads the same config for the neighbouring contract
 * (wechat emits exactly one JS file). Both came out of the same stray `90.pixigame.js`: that file
 * pins the build-level backstop (`asyncChunks:false` inlines any split point), this one removes the
 * dependency that produced it. Kept separate because they fail for different reasons and a reader
 * chasing one shouldn't have to read the other.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { Capacitor } from '../src/platform/stubs/capacitorCore';
import { LocalNotifications } from '../src/platform/stubs/localNotifications';

const CLIENT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(CLIENT_DIR, 'src');
const STUB_DIR = 'src/platform/stubs';
// Every entry in src/entries/ except mobile.ts — `web-e2e` included, since the browser smoke tests
// are supposed to exercise the same graph the real web build ships.
const NON_MOBILE_TARGETS = ['web', 'crazygames', 'wechat', 'web-e2e'] as const;

// webpack.config.js sits outside every tsconfig `include` (same reason as
// preloadBootAssetsPlugin.test.ts's plugin require), so load it as the CommonJS module it is.
const requireJs = createRequire(path.join(__dirname, 'capacitorStubs.test.ts'));
type ConfigFactory = (
  env: { TARGET: string },
  argv: { mode: string },
) => { plugins: unknown[] };
const configFactory = requireJs('../webpack.config.js') as ConfigFactory;

/** The module-replacement table the given target actually builds with, as `{ from, to }` pairs. */
function replacements(target: string): { from: RegExp; to: string }[] {
  // mode:development keeps the production-only NW_*_BASE guard (unrelated to this file) quiet.
  const { plugins } = configFactory({ TARGET: target }, { mode: 'development' });
  return plugins
    .filter((p): p is { constructor: { name: string }; resourceRegExp: RegExp; newResource: unknown } =>
      !!p && (p as { constructor?: { name?: string } }).constructor?.name === 'NormalModuleReplacementPlugin')
    // The `.hires` art swap is the other user of this plugin; it rewrites requests from a callback.
    .filter((p) => typeof p.newResource === 'string')
    .map((p) => ({ from: p.resourceRegExp, to: (p.newResource as string).replace(/\\/g, '/') }));
}

/** Every `.ts` under src/, client-relative with forward slashes. */
function allSources(dir = SRC_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return allSources(full);
    if (!e.name.endsWith('.ts')) return [];
    return [path.relative(CLIENT_DIR, full).replace(/\\/g, '/')];
  });
}

function read(rel: string): string {
  return fs.readFileSync(path.join(CLIENT_DIR, rel), 'utf8');
}

/** Bare `@capacitor/*` / `@capgo/*` package specifiers imported by a file (type-only imports skipped). */
function nativeImportsOf(rel: string): string[] {
  const src = read(rel);
  const out = new Set<string>();
  for (const m of src.matchAll(/^import\s+(?!type\s)[^;]*?from\s+'(@cap(?:acitor|go)\/[^']+)'/gm)) {
    out.add(m[1]);
  }
  return [...out];
}

describe('non-mobile builds carry no Capacitor runtime', () => {
  it('every native-only package in the shared graph is stubbed on every non-mobile target', () => {
    // ota.ts is exempt by *reachability*, not by a stub — see the next test.
    const shared = allSources().filter((f) => !f.startsWith(STUB_DIR) && f !== 'src/platform/ota.ts');
    const imported = [...new Set(shared.flatMap(nativeImportsOf))].sort();
    // Sanity: if this ever empties out, the assertion below would pass vacuously.
    expect(imported).toEqual(['@capacitor/core', '@capacitor/local-notifications']);

    for (const target of NON_MOBILE_TARGETS) {
      const table = replacements(target);
      for (const pkg of imported) {
        const hit = table.find((r) => r.from.test(pkg));
        expect(hit, `${target}: no stub for ${pkg}`).toBeDefined();
        expect(hit!.to).toContain(`${STUB_DIR}/`);
        expect(fs.existsSync(hit!.to), `${target}: stub file for ${pkg} is missing`).toBe(true);
      }
    }
  });

  it('the @capgo OTA plugin stays reachable from the mobile entry only', () => {
    // ota.ts imports @capgo/capacitor-updater unconditionally and has no stub, so the thing keeping
    // it out of the other three bundles is that nothing they reach imports it. Importing ota.ts from
    // shared code (app.ts, a scene, platform/*) would silently undo that.
    const importers = allSources().filter(
      (f) => f !== 'src/platform/ota.ts' && /from '[^']*\/ota'/.test(read(f)),
    );
    expect(importers).toEqual(['src/entries/mobile.ts']);
    expect(nativeImportsOf('src/platform/ota.ts')).toEqual(['@capgo/capacitor-updater']);
  });

  it('the mobile build keeps the real packages', () => {
    // The whole point of these stubs is that mobile is the one target Capacitor is real on.
    // Scoped to `@capacitor/*` rather than "mobile stubs nothing": the stub mechanism also runs in
    // the opposite direction now (web-only paddleCheckout → a stub on mobile, see
    // nativePaymentIsolation.test.ts), and that swap is not this file's contract.
    const capacitorStubs = [`${STUB_DIR}/capacitorCore.ts`, `${STUB_DIR}/localNotifications.ts`];
    expect(replacements('mobile').filter((r) => capacitorStubs.some((s) => r.to.endsWith(s)))).toEqual([]);
  });
});

describe('stub surface matches its call sites', () => {
  // localReminders.ts is the only consumer of either package (asserted above).
  const callSite = read('src/platform/localReminders.ts');

  /** Method names the call site reaches on `binding`, e.g. `LocalNotifications.schedule(...)`. */
  function membersUsed(binding: string): string[] {
    const used = [...callSite.matchAll(new RegExp(`\\b${binding}\\.(\\w+)\\s*\\(`, 'g'))];
    return [...new Set(used.map((m) => m[1]))].sort();
  }

  it('LocalNotifications stub defines every method the call site calls', () => {
    const used = membersUsed('LocalNotifications');
    expect(used.length).toBeGreaterThan(0);
    expect(Object.keys(LocalNotifications).sort()).toEqual(expect.arrayContaining(used));
  });

  it('Capacitor stub defines every method the call site calls', () => {
    const used = membersUsed('Capacitor');
    expect(used).toContain('isNativePlatform');
    expect(Object.keys(Capacitor).sort()).toEqual(expect.arrayContaining(used));
  });

  it('the platform gate reads false, so the native branches are dead in these bundles', () => {
    expect(Capacitor.isNativePlatform()).toBe(false);
    expect(Capacitor.getPlatform()).toBe('web');
  });

  it('plugin methods throw rather than pretend to have scheduled anything', () => {
    // localReminders.ts wraps every call in try/catch, so a throw degrades to the same no-op as a
    // denied permission — but it shows up in a log instead of looking like success.
    for (const [name, fn] of Object.entries(LocalNotifications)) {
      expect(() => (fn as () => unknown)(), name).toThrow(/stubbed out/);
    }
  });
});
