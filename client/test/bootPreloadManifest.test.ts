/**
 * bootPreloadManifest.test.ts — drift guard between the boot manifest and the
 * `<link rel="preload">` list (ASSET_PACKAGING §11).
 *
 * `client/build/preloadBootAssets.js` is a webpack plugin, so it cannot import
 * `bootManifest.ts` (TS, and its import graph pulls in PIXI + binary assets) — it
 * carries its own copy of the two tiers' file paths. A copy that silently rots is
 * worse than no preload at all: a renamed asset would drop out of the head tags and
 * quietly give back the regression this was built to fix, with nothing failing.
 *
 * So this test re-derives both tiers from `bootManifest.ts`'s own source text and
 * asserts they match the plugin's lists exactly — including which tier each asset is
 * in, since the tier decides `fetchpriority`. Deriving from source (rather than
 * importing the module) is what keeps this test in the fast node suite.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const CLIENT_DIR = path.resolve(__dirname, '..');
const BOOT_MANIFEST = 'src/assets/bootManifest.ts';
const PRELOAD_PLUGIN = 'build/preloadBootAssets.js';

/** Atlas modules the manifest loads by name; each owns exactly one `.png` import. */
const ATLAS_MODULES: Record<string, string> = {
  decorMergedAtlas: 'src/render/atlas/decorMergedAtlas.ts',
  iconsAtlas:       'src/render/atlas/iconsAtlas.ts',
};

const read = (rel: string): string => fs.readFileSync(path.join(CLIENT_DIR, rel), 'utf8');

/** Client-relative, forward-slashed — the form webpack reports as `assetInfo.sourceFilename`. */
const clientRelative = (fromFile: string, importPath: string): string =>
  path.posix.normalize(path.posix.join(path.posix.dirname(fromFile.replace(/\\/g, '/')), importPath));

/** `import fooUrl from './units/foo.png'` → { fooUrl: 'src/assets/units/foo.png' }. */
function assetImports(sourceRel: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /import\s+(\w+)\s+from\s+'([^']+\.(?:png|tao))'/g;
  for (const [, ident, importPath] of read(sourceRel).matchAll(re)) {
    out[ident] = clientRelative(sourceRel, importPath);
  }
  return out;
}

/** The `[...]` body of a top-level `const <name>... = [ ... \n];` declaration. */
function arrayBlock(source: string, where: string, decl: string): string {
  const start = source.indexOf(decl);
  expect(start, `\`${decl}\` not found in ${where} — update this test`).toBeGreaterThan(-1);
  const end = source.indexOf('\n];', start);
  expect(end, `\`${decl}\` has no closing bracket`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * The plugin's own copy of a tier, read out of its source text rather than `require`d:
 * `build/` sits outside every tsconfig `include`, so importing it would mean either
 * `allowJs` or an untyped-module error in `npm run typecheck`.
 */
function pluginTier(name: string): string[] {
  const block = arrayBlock(read(PRELOAD_PLUGIN), PRELOAD_PLUGIN, `const ${name} = [`);
  return [...block.matchAll(/'([^']+)'/g)].map(([, p]) => p);
}

describe('boot preload manifest', () => {
  const manifestSource = read(BOOT_MANIFEST);
  const GATE_ASSETS = pluginTier('GATE_ASSETS');
  const BACKGROUND_ASSETS = pluginTier('BACKGROUND_ASSETS');

  // identifier -> client-relative asset path, for both direct imports and the two atlases.
  const byIdentifier: Record<string, string> = { ...assetImports(BOOT_MANIFEST) };
  for (const [ident, moduleRel] of Object.entries(ATLAS_MODULES)) {
    const pngs = Object.values(assetImports(moduleRel));
    expect(pngs, `${moduleRel} should import exactly one png`).toHaveLength(1);
    byIdentifier[ident] = pngs[0];
  }

  const tierFor = (blockName: string): string[] => {
    const block = arrayBlock(manifestSource, BOOT_MANIFEST, `const ${blockName}: BootStep[] = [`);
    return Object.entries(byIdentifier)
      .filter(([ident]) => new RegExp(`\\b${ident}\\b`).test(block))
      .map(([, assetPath]) => assetPath);
  };

  it('every boot asset is preloaded, in the tier the manifest puts it in', () => {
    const gate = tierFor('STEPS');
    const background = tierFor('BACKGROUND_STEPS');

    // Guards the regexes themselves: a formatting change that stops them matching
    // would otherwise "pass" by comparing two empty sets.
    expect(gate.length).toBeGreaterThan(0);
    expect(background.length).toBeGreaterThan(0);

    expect([...gate].sort()).toEqual([...GATE_ASSETS].sort());
    expect([...background].sort()).toEqual([...BACKGROUND_ASSETS].sort());
  });

  it('lists no asset that is missing from disk', () => {
    for (const rel of [...GATE_ASSETS, ...BACKGROUND_ASSETS]) {
      expect(fs.existsSync(path.join(CLIENT_DIR, rel)), `${rel} does not exist`).toBe(true);
    }
  });

  it('puts each asset in exactly one tier', () => {
    expect(GATE_ASSETS.filter((a) => BACKGROUND_ASSETS.includes(a))).toEqual([]);
  });
});
