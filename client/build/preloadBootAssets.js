/**
 * preloadBootAssets.js — inject `<link rel="preload">` for the boot-tier assets
 * (ASSET_PACKAGING §11).
 *
 * Without this, nothing about the boot assets is discoverable until the browser has
 * downloaded AND parsed AND executed the ~1.5 MB bundle far enough to reach
 * `startApp`'s `preloadBoot()` call — only then does the first asset request leave
 * the machine. The assets are content-hashed, so their URLs are only known at build
 * time; this plugin looks each one up in the emitted-asset table (webpack records the
 * originating file in `assetInfo.sourceFilename` for `asset/resource` modules) and
 * writes the resolved URL into the HTML head. The browser then fetches them in
 * parallel with the bundle instead of after it.
 *
 * `fetchpriority` splits the two tiers so the gate is never starved by the
 * background tier (see `bootManifest.ts` for what the tiers mean):
 *   - GATE assets block the loading screen  → `high`
 *   - BACKGROUND assets are warmed after it → `low`
 * Chrome honours both; browsers without `fetchpriority` support just get two plain
 * preloads, which is still strictly better than no preload at all.
 *
 * ⚠ `crossorigin` is REQUIRED even though every asset is same-origin, and leaving it
 * off silently un-does the whole plugin. A preload with no `crossorigin` has
 * credentials mode "include", while both consumers ask for "same-origin" — PIXI's
 * ImageResource assigns `img.crossOrigin` (empty string ≡ anonymous) and
 * StickmanRuntime uses a default `fetch()`. The modes have to match or the browser
 * treats the preloaded response as unusable, drops it, and requests the file a SECOND
 * time — measurably worse than not preloading. Chrome says so out loud
 * ("...but is not used because the request credentials mode does not match"), which is
 * how this was caught; `crossorigin="anonymous"` lines both sides up at "same-origin".
 *
 * WeChat has no HTML host and bakes absolute CDN URLs at build time, so this plugin
 * is only wired up for the HTML targets (see webpack.config.js).
 *
 * ⚠ The two lists below mirror what `client/src/assets/bootManifest.ts` imports, and
 * must stay in the same tier the manifest puts them in. `client/test/bootPreloadManifest.test.ts`
 * re-derives both tiers from the manifest source and fails if they ever drift apart.
 */
const HtmlWebpackPlugin = require('html-webpack-plugin');

/** Blocks the L0 loading screen — everything the first lobby paint can show. */
const GATE_ASSETS = [
  'src/assets/units/infantry.png',
  'src/assets/units/archer.png',
  'src/assets/units/shieldbearer.png',
  'src/assets/buildings/game_base.png',
  'src/assets/buildings/game_infantry_barracks.png',
  'src/assets/buildings/game_arrow_tower.png',
  'src/assets/logo.png',
  'src/assets/icons/icons_atlas.png',
];

/** Warmed after the gate; re-gated by `enterBattle` before any battle can use them. */
const BACKGROUND_ASSETS = [
  'src/assets/units/infantry.tao',
  'src/assets/units/archer.tao',
  'src/assets/units/shieldbearer.tao',
  'src/assets/decor/decor_merged_atlas.png',
];

/** `.tao` rigs are read with `fetch()`; everything else is a texture. */
function asAttrFor(sourceFile) {
  return sourceFile.endsWith('.tao') ? 'fetch' : 'image';
}

/**
 * Distinct http(s) origins from a list of baked backend base URLs.
 *
 * Empty strings are the "same-origin, reverse-proxied" case (web/CrazyGames production) — the
 * browser is already connected to that origin, so a preconnect would be noise. Anything
 * unparseable is dropped rather than thrown on: a bad base URL must not break a release build,
 * and net/config.ts is the place that gets to complain about it.
 */
function backendOrigins(urls) {
  const origins = [];
  for (const url of urls) {
    if (!url) continue;
    let origin;
    try { origin = new URL(url).origin; } catch { continue; }
    if (!/^https?:$/.test(new URL(url).protocol)) continue;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * `opts.preconnect`: backend base URLs whose connection should be opened DURING the boot gate.
 *
 * Rationale (ASSET_PACKAGING §11, extended 2026-08-25): `startApp` awaits `preloadBoot()` and only
 * afterwards does `core.start()` → `resolveEntry()` fire the first backend request. The lobby's
 * first paint does not block on that request (resolveEntry navigates immediately and pulls in the
 * background), so this is not about first paint — it is about how long the lobby shows local/stale
 * values before the server-authoritative pull lands, and about the resume-match prompt. On a cold
 * link the first request to a cross-origin backend pays DNS + TCP + TLS before a single byte of
 * `/save` moves, and today all of that sits *after* the gate. A preconnect moves the handshake
 * into the gate's own dead time, which is exactly when the connection is idle anyway.
 *
 * `crossorigin` is required for the same reason it is on the preloads above — the backend is
 * fetched with CORS, and a preconnect socket opened without it is not the one that gets reused.
 */
class PreloadBootAssetsPlugin {
  constructor(opts = {}) {
    this.preconnectOrigins = backendOrigins(opts.preconnect ?? []);
  }

  apply(compiler) {
    compiler.hooks.compilation.tap('PreloadBootAssetsPlugin', (compilation) => {
      HtmlWebpackPlugin.getHooks(compilation).alterAssetTagGroups.tap(
        'PreloadBootAssetsPlugin',
        (data) => {
          // sourceFilename is the module's path relative to the compiler context
          // (client/), always with forward slashes — including on Windows.
          const emitted = new Map();
          for (const asset of compilation.getAssets()) {
            const src = asset.info && asset.info.sourceFilename;
            if (src) emitted.set(src, asset.name);
          }

          const publicPath = data.publicPath === 'auto' ? '' : (data.publicPath || '');
          const tags = [];
          const add = (sourceFile, fetchpriority) => {
            // On the `mobile` target an asset with a `<name>.hires.<ext>` sibling is
            // swapped for it at resolve time (ASSET_PACKAGING §9), so the emitted table
            // has the sibling's path, not the one listed here. Follow the same convention
            // rather than duplicating the lists per target — `logo.png` is exactly this case.
            const name = emitted.get(sourceFile)
              ?? emitted.get(sourceFile.replace(/(\.[^.]+)$/, '.hires$1'));
            // A missing entry means the import was dropped/renamed. Warn rather than
            // throw: a stale preload list must not be able to break a release build.
            if (!name) {
              compilation.warnings.push(
                new Error(`[preload-boot-assets] no emitted asset for "${sourceFile}" — preload skipped (list out of date?)`)
              );
              return;
            }
            tags.push({
              tagName: 'link',
              voidTag: true,
              meta: { plugin: 'PreloadBootAssetsPlugin' },
              attributes: {
                rel: 'preload',
                href: publicPath + name,
                as: asAttrFor(sourceFile),
                crossorigin: 'anonymous', // see the header note — not optional
                fetchpriority,
              },
            });
          };

          for (const f of GATE_ASSETS) add(f, 'high');
          for (const f of BACKGROUND_ASSETS) add(f, 'low');

          // Ahead of the bundle's own <script>: the preload scanner should see these
          // before it commits bandwidth to the (much larger) JS file.
          data.headTags.unshift(...tags);

          // Ahead of even those: a handshake costs no bandwidth to speak of, and the sooner it
          // starts the more of it overlaps the bundle download + the boot gate.
          data.headTags.unshift(...this.preconnectOrigins.map((href) => ({
            tagName: 'link',
            voidTag: true,
            meta: { plugin: 'PreloadBootAssetsPlugin' },
            attributes: { rel: 'preconnect', href, crossorigin: 'anonymous' },
          })));
          return data;
        }
      );
    });
  }
}

module.exports = PreloadBootAssetsPlugin;
