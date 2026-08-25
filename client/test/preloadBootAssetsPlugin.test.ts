/**
 * preloadBootAssetsPlugin.test.ts — behavioural coverage for `client/build/preloadBootAssets.js`
 * (ASSET_PACKAGING §11.1).
 *
 * `bootPreloadManifest.test.ts` guards the plugin's asset LISTS against drift; this file guards
 * the tags it builds out of them. That split matters because the two fail in completely different
 * ways: a stale list drops one preload, but a wrong ATTRIBUTE silently breaks all of them at once
 * and can make the page slower than shipping no preloads at all — which is exactly what the
 * missing `crossorigin` did on the first cut of this plugin (found by reading Chrome's console,
 * not by any test; hence this file).
 *
 * Runs the plugin against a fake compiler/compilation instead of a real webpack build: a real
 * build is ~18s per target, and `HtmlWebpackPlugin.getHooks()` is happy to attach its hook map to
 * any object, so the whole tag-generation path is reachable in milliseconds.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import HtmlWebpackPlugin from 'html-webpack-plugin';

const CLIENT_DIR = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(CLIENT_DIR, 'src/assets');

// `build/` sits outside every tsconfig `include`, so a plain `import` of the plugin is an
// untyped-module error under `npm run typecheck`. createRequire loads it as the CommonJS
// module it is, with the shape asserted here instead.
const requireJs = createRequire(path.join(__dirname, 'preloadBootAssetsPlugin.test.ts'));
const PreloadBootAssetsPlugin = requireJs('../build/preloadBootAssets.js') as new (opts?: {
  preconnect?: string[];
}) => {
  apply(compiler: unknown): void;
};

interface FakeAsset { name: string; info: { sourceFilename?: string } }
interface Tag { tagName: string; attributes: Record<string, string> }

/** Every `.png`/`.tao` under src/assets, client-relative with forward slashes. */
function allAssetSources(dir = ASSETS_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return allAssetSources(full);
    if (!/\.(png|tao)$/i.test(e.name)) return [];
    return [path.relative(CLIENT_DIR, full).replace(/\\/g, '/')];
  });
}

/**
 * Drive the plugin once and return the tags it prepended plus any warnings.
 *
 * `sources` becomes the emitted-asset table. Passing EVERY asset file by default (rather than a
 * copy of the plugin's own lists) keeps this file decoupled from which assets are currently in
 * which tier — it asserts properties that must hold for whatever the lists happen to contain.
 */
async function run(opts: { sources?: string[]; publicPath?: string; preconnect?: string[] } = {}): Promise<{ tags: Tag[]; warnings: string[]; headTags: unknown[] }> {
  const sources = opts.sources ?? allAssetSources();
  const assets: FakeAsset[] = sources.map((src, i) => ({
    name: `${String(i).padStart(20, '0')}${path.extname(src)}`,
    info: { sourceFilename: src },
  }));

  const warnings: Error[] = [];
  const compilation = { warnings, getAssets: () => assets };
  let onCompilation: ((c: unknown) => void) | null = null;
  const compiler = { hooks: { compilation: { tap: (_n: string, fn: (c: unknown) => void) => { onCompilation = fn; } } } };

  // No `preconnect` by default, so every existing assertion below still sees preload tags only.
  new PreloadBootAssetsPlugin({ preconnect: opts.preconnect ?? [] }).apply(compiler);
  expect(onCompilation, 'plugin never tapped compiler.hooks.compilation').not.toBeNull();
  onCompilation!(compilation);

  const existingScript = { tagName: 'script', attributes: { src: 'bundle.js' } };
  const data = { headTags: [existingScript] as unknown[], publicPath: opts.publicPath ?? '' };
  // alterAssetTagGroups is an AsyncSeriesWaterfallHook — the plugin taps it synchronously (as
  // html-webpack-plugin's own docs do) but it can only be invoked through promise/callAsync.
  const out = await HtmlWebpackPlugin.getHooks(compilation as never).alterAssetTagGroups.promise(data as never) as unknown as typeof data;

  const tags = out.headTags.filter((t) => (t as Tag).tagName === 'link') as Tag[];
  return { tags, warnings: warnings.map((w) => w.message), headTags: out.headTags };
}

describe('preloadBootAssets plugin', () => {
  it('emits a preload link per boot asset, ahead of the bundle script', async () => {
    const { tags, warnings, headTags } = await run();
    expect(warnings).toEqual([]);
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t.attributes.rel).toBe('preload');
    // The preload scanner must see these before it commits bandwidth to the bundle.
    expect((headTags[headTags.length - 1] as Tag).tagName).toBe('script');
    expect((headTags[0] as Tag).tagName).toBe('link');
  });

  // The regression lock for the bug this plugin shipped with. Without `crossorigin` the preload's
  // credentials mode is "include" while PIXI's ImageResource (`img.crossOrigin`) and
  // StickmanRuntime's default `fetch()` both ask for "same-origin"; the browser then refuses to
  // reuse the preloaded response and downloads every asset a second time.
  it('marks every tag crossorigin=anonymous so the preloaded response is actually reused', async () => {
    const { tags } = await run();
    for (const t of tags) expect(t.attributes.crossorigin).toBe('anonymous');
  });

  it('asks for the destination each consumer actually uses', async () => {
    for (const t of (await run()).tags) {
      // .tao rigs go through fetch(); everything else becomes a texture.
      expect(t.attributes.as).toBe(t.attributes.href.endsWith('.tao') ? 'fetch' : 'image');
    }
  });

  it('gives the gate tier priority over the background tier, and orders it first', async () => {
    const priorities = (await run()).tags.map((t) => t.attributes.fetchpriority);
    expect(new Set(priorities)).toEqual(new Set(['high', 'low']));
    // All high before all low: the background tier must never be positioned to starve the tier
    // the loading screen is actually waiting on.
    expect(priorities).toEqual([...priorities].sort((a, b) => (a === b ? 0 : a === 'high' ? -1 : 1)));
  });

  it('prefixes href with the public path, treating webpack\'s "auto" as same-directory', async () => {
    for (const t of (await run({ publicPath: '/static/' })).tags) expect(t.attributes.href.startsWith('/static/')).toBe(true);
    for (const t of (await run({ publicPath: 'auto' })).tags) expect(t.attributes.href).not.toContain('auto');
  });

  // ASSET_PACKAGING §9: the mobile target swaps any asset with a `<name>.hires.<ext>` sibling for
  // that sibling at resolve time, so the emitted table holds the sibling's path. logo.png is the
  // live case, and the first cut of the plugin silently dropped it from the mobile build.
  it('follows the .hires redirect the mobile build applies', async () => {
    const sources = allAssetSources().filter((s) => s !== 'src/assets/logo.png');
    expect(sources).toContain('src/assets/logo.hires.png'); // guards the fixture itself
    const { tags, warnings } = await run({ sources });
    expect(warnings).toEqual([]);
    expect(tags.length).toBe((await run()).tags.length);
  });

  it('warns and skips a listed asset that was never emitted, without dropping the rest', async () => {
    const full = await run();
    // Drop one file the plugin is known to list (it produced a tag in the full run).
    const dropped = 'src/assets/icons/icons_atlas.png';
    const { tags, warnings } = await run({ sources: allAssetSources().filter((s) => s !== dropped) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(dropped);
    // A stale list must not be able to break a release build, only shrink the preload set.
    expect(tags.length).toBe(full.tags.length - 1);
  });
});

/**
 * Backend preconnect (ASSET_PACKAGING §11, added 2026-08-25). `startApp` only fires its first
 * backend request after the L0 gate resolves, so on a cold link the DNS + TCP + TLS handshake to a
 * cross-origin backend lands entirely after the gate — while the connection sat idle throughout it.
 */
describe('preloadBootAssets plugin — backend preconnect', () => {
  const preconnects = (tags: Tag[]): Tag[] => tags.filter((t) => t.attributes.rel === 'preconnect');

  it('emits one preconnect per distinct backend origin', async () => {
    const { tags } = await run({
      preconnect: [
        'https://api.gamestao.com/api',
        'https://api.gamestao.com',       // same origin as the first — must collapse
        'https://cdn.example.com/assets',
      ],
    });
    expect(preconnects(tags).map((t) => t.attributes.href))
      .toEqual(['https://api.gamestao.com', 'https://cdn.example.com']);
  });

  // Web/CrazyGames production bakes '' for the same-origin, reverse-proxied backends. The browser
  // is already connected to that origin, so a preconnect there is pure noise in the head.
  it('drops empty (same-origin) and unparseable bases rather than emitting junk', async () => {
    const { tags, warnings } = await run({ preconnect: ['', 'not a url', 'wss://api.example.com/gw'] });
    expect(preconnects(tags)).toEqual([]);
    expect(warnings).toEqual([]); // a bad base URL is net/config.ts's complaint, not a build failure
  });

  // Same reasoning as the preload tags: the backend is fetched with CORS, and a socket opened
  // without matching credentials mode is not the one that gets reused.
  it('marks preconnects crossorigin=anonymous, ahead of the asset preloads', async () => {
    const { tags } = await run({ preconnect: ['https://api.gamestao.com'] });
    expect(tags[0].attributes.rel).toBe('preconnect');
    expect(tags[0].attributes.crossorigin).toBe('anonymous');
    expect(tags[1].attributes.rel).toBe('preload');
  });
});
