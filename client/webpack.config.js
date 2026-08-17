const path = require('path');
const fs = require('fs');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const PreloadBootAssetsPlugin = require('./build/preloadBootAssets');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';
  const targetPlatform = env.TARGET || 'web';
  const isWechat = targetPlatform === 'wechat';
  // Native (Capacitor iOS/Android) build. The bundle runs from capacitor://localhost, so there is
  // no same-origin backend — every backend URL must be baked as an absolute production address
  // (IOS_RELEASE.md §build). Env vars still override for staging/sandbox builds.
  const isMobile = targetPlatform === 'mobile';
  const MOBILE_ORIGIN = 'https://api.gamestao.com';

  // metaserver REST base URL / gateway control-plane WS: injected as globals at build time,
  // read at runtime by net/config.ts.
  // Environment variables take priority (CI/production: NW_API_BASE=https://host/api);
  // dev defaults point to local metaserver (NW_META_PORT default 18080) + gateway
  // (NW_GW_PORT default 8086) — works out of the box for local registration and multiplayer.
  // Note: ports 8082/8083 fall inside the Windows TCP excludedportrange (WinNAT/Hyper-V dynamic
  // reservation) and will EACCES on bind, so gateway uses 8086 instead
  // (must match NW_GW_PORT / NW_GATEWAY_PUBLIC_WS_URL in dev-up.ps1).
  // If not configured in production, values are empty → net/config returns null → degrades to
  // local offline-only mode.
  const apiBase = process.env.NW_API_BASE || (isMobile ? `${MOBILE_ORIGIN}/api` : (isProd ? '' : 'http://localhost:18080'));
  const gatewayWs = process.env.NW_GATEWAY_WS || (isMobile ? 'wss://api.gamestao.com/gw' : (isProd ? '' : 'ws://localhost:8086/gw'));
  const worldBase = process.env.NW_WORLD_BASE || (isMobile ? MOBILE_ORIGIN : (isProd ? '' : 'http://localhost:18084'));
  // Social base: web/CrazyGames default to '' (same-origin, reverse-proxied). Native has no
  // same-origin backend, so it must be baked absolute like the others.
  const socialBase = process.env.NW_SOCIAL_BASE || (isMobile ? MOBILE_ORIGIN : '');
  // Auction base: same reasoning as social — web/CrazyGames derive port 18086 client-side (net/config.ts
  // getAuctionBaseUrl), native has no same-origin backend so it must be baked absolute like the others.
  const auctionBase = process.env.NW_AUCTION_BASE || (isMobile ? MOBILE_ORIGIN : '');

  // Guard against the 2026-08-02 production incident: net/config.ts's getSocialBaseUrl()/getAuctionBaseUrl()
  // fall back to deriving a dev-only port (8085/18086) from NW_WORLD_BASE whenever their own env var is
  // unset — correct for local dev (worldBase defaults to localhost there too), but once a non-mobile
  // build bakes NW_WORLD_BASE to a real domain (production web: Caddy does *path* routing on one origin,
  // not per-service ports), that derived port is an internal Docker-only address, unreachable from
  // outside. NW_SOCIAL_BASE got this fix once already; NW_AUCTION_BASE was never added when auctionsvc
  // split out, silently breaking the whole auction house. Fail the build instead of shipping a broken
  // fallback — add new entries here whenever a getXBaseUrl() following this pattern joins net/config.ts.
  const DERIVED_PORT_BACKEND_ENVS = ['NW_SOCIAL_BASE', 'NW_AUCTION_BASE'];
  if (isProd && !isMobile && worldBase) {
    for (const key of DERIVED_PORT_BACKEND_ENVS) {
      if (!process.env[key]) {
        throw new Error(
          `${key} must be set explicitly for this build (NW_WORLD_BASE=${worldBase} is baked to a real ` +
          `domain, not empty/localhost) — left unset, net/config.ts derives an internal Docker-only port ` +
          `from NW_WORLD_BASE that is unreachable from outside. See design/product/deploy-cloudflare.md.`
        );
      }
    }
  }
  // WeChat mini-game Plan A asset CDN base URL (ASSET_PACKAGING §4). WeChat builds only:
  // asset/resource publicPath is set to this value so imports are baked into absolute URLs
  // `<CDN>/cdn/<hash>.png`; asset files are output to wechatgame/cdn/ (excluded from the
  // main package by project.config packOptions.ignore and uploaded to the CDN separately).
  // If empty, falls back to relative paths inside the package (whole-package mode, for local
  // IDE testing only). Web/CrazyGames ignore this (same-origin relative URLs).
  const assetCdn = (process.env.NW_ASSET_CDN || '').replace(/\/+$/, '');

  return {
    target: 'web',
    mode: isProd ? 'production' : 'development',
    entry: `./src/entries/${targetPlatform}.ts`,
    devtool: isWechat ? 'source-map' : (isProd ? false : 'source-map'),
    module: {
      rules: [
        { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
        {
          test: /\.(png|jpg|gif|webp|mp3|wav|ogg|tao)$/i,
          type: 'asset/resource',
          // WeChat (Plan A): assets go into the cdn/ subdirectory and URLs are baked as
          // absolute CDN addresses; at runtime WechatAssetIO uses downloadFile + local cache
          // (WeChat has no fetch). Web/CrazyGames: default behavior (dist root + same-origin relative URL).
          ...(isWechat ? {
            generator: {
              filename: 'cdn/[contenthash][ext]',
              publicPath: assetCdn ? `${assetCdn}/` : '',
            },
          } : {}),
        },
        { test: /\.css$/i, use: ['style-loader', 'css-loader'] },
      ],
    },
    resolve: {
      extensions: ['.ts', '.js'],
      alias: {
        // @nw/engine = the deterministic core (server/engine/src), consumed as
        // TS source via ts-loader. client's first cross-boundary bridge (§16.7).
        '@nw/engine$': path.resolve(__dirname, '../server/engine/src/index.ts'),
        '@nw/engine': path.resolve(__dirname, '../server/engine/src'),
        // @nw/shared/cards = card catalogue + pure progression constants (cards.ts has zero
        // runtime imports — only `import type` — so it's browser-safe on its own). Lets
        // client/src/game/meta/cardDefs.ts import the real inventory-cap/level constants
        // instead of maintaining a second copy (CHARACTER_CARDS_DESIGN §2/§3). Must precede
        // the general '@nw/shared' entry below (more specific alias wins).
        '@nw/shared/cards': path.resolve(__dirname, '../server/shared/src/cards.ts'),
        // @nw/shared = browser-safe slice of server/shared. Points directly to slg/index.ts
        // (pure/deterministic, no Node.js built-ins) to avoid pulling in password/logger
        // which import node:crypto / node:fs / node:path and break webpack browser builds.
        '@nw/shared': path.resolve(__dirname, '../server/shared/src/slg/index.ts'),
      },
    },
    output: isWechat ? {
      // WeChat shell game.js uses `require('./pixigame.js')`: single IIFE bundle, self-executing.
      // clean:false preserves game.js/game.json/assets/ in the same directory.
      // globalObject=globalThis adapts to the WeChat runtime (no window/self).
      filename: 'pixigame.js',
      path: path.resolve(__dirname, 'wechatgame'),
      clean: false,
      iife: true,
      globalObject: 'globalThis',
      // asyncChunks:false enforces the "single self-executing file" contract above (ASSET_PACKAGING
      // §4.0) instead of merely describing it: any `import()` reachable from the wechat entry is
      // inlined into pixigame.js rather than split into a `<id>.pixigame.js` sibling. Without this,
      // one third-party dynamic import silently (a) emits an extra chunk file that game.js never
      // requires and project.config never packs, and (b) drags webpack's JSONP chunk-loading runtime
      // (document.createElement('script') / importScripts) into the bundle — neither exists in the
      // WeChat runtime, so the first chunk request would throw rather than degrade.
      // Real case (2026-08-17): @capacitor/local-notifications registers its web implementation as
      // `web: () => import('./web')` (Capacitor's standard lazy-impl pattern), and
      // platform/localReminders.ts imports it on every target, not just mobile — that alone produced
      // a stray `90.pixigame.js`. It happened to be unreachable (every call site is behind
      // `Capacitor.isNativePlatform()`, and the loader only runs when a plugin method is actually
      // called), but "unreachable" is a property of today's call sites, not of the build.
      asyncChunks: false,
    } : {
      filename: isProd ? '[contenthash].js' : 'index.js',
      path: path.resolve(__dirname, 'dist'),
      clean: true,
    },
    plugins: [
      // WeChat has no HTML host (game.js requires pixigame.js); HtmlWebpackPlugin / version.json / _headers are Web-only.
      ...(isWechat ? [] : [new HtmlWebpackPlugin({ template: `./public/${targetPlatform}/index.html` })]),
      // <link rel="preload"> for the boot-tier assets, so the browser starts fetching them
      // during the bundle download instead of after startApp() runs (ASSET_PACKAGING §11).
      // Needs HtmlWebpackPlugin's hooks, hence WeChat (no HTML host) is excluded.
      ...(isWechat ? [] : [new PreloadBootAssetsPlugin()]),
      // Copy marketing landing (home) + legal pages (terms/privacy/refunds/pricing) + branding icons
      // (favicon / apple-touch / PWA manifest, referenced by <link> in the HTML templates) to dist root.
      // home.html is the crawler-readable site Paddle reviews (the game root / is a bare canvas).
      ...(!isWechat ? [new CopyPlugin({ patterns: [
        { from: 'public/web/home.html' }, { from: 'public/web/terms.html' }, { from: 'public/web/privacy.html' }, { from: 'public/web/refunds.html' }, { from: 'public/web/pricing.html' },
        // pay.html: standalone Paddle checkout surface, set as the Dashboard "Default payment link"
        // (handles hosted-checkout ?_ptxn links from receipts / retry emails). See COMMERCIAL_DESIGN §IAP.
        { from: 'public/web/pay.html' },
        { from: 'public/favicon-16.png' }, { from: 'public/favicon-32.png' }, { from: 'public/favicon-48.png' },
        { from: 'public/apple-touch-icon.png' }, { from: 'public/icon-192.png' }, { from: 'public/icon-512.png' },
        { from: 'public/site.webmanifest' },
      ] })] : []),
      // Emit version.json at build time (for client version polling) and _headers (CF Workers / nginx cache policy).
      ...(isProd && !isWechat ? [{
        apply(compiler) {
          const version = process.env.NW_BUILD_VERSION || '0.0.0';
          compiler.hooks.thisCompilation.tap('StaticMetaPlugin', (compilation) => {
            compilation.hooks.processAssets.tap(
              { name: 'StaticMetaPlugin', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
              () => {
                compilation.emitAsset('version.json', new webpack.sources.RawSource(JSON.stringify({ v: version })));
                // _headers: Cloudflare Workers static assets support this file for response-header control.
                // index.html / version.json: no-cache; JS files with contenthash: cache forever.
                const headers = [
                  '/index.html',
                  '  Cache-Control: no-cache, must-revalidate',
                  '/version.json',
                  '  Cache-Control: no-cache, must-revalidate',
                ].join('\n');
                compilation.emitAsset('_headers', new webpack.sources.RawSource(headers));
              }
            );
          });
        },
      }] : []),
      // High-res/compressed asset split (client-resource-mgmt audit 2026-07-29): the native app
      // shell (Capacitor + Capgo OTA) bundles its assets locally and mostly reads from its own
      // persistent cache between infrequent OTA updates, so it can afford noticeably larger source
      // art than web/WeChat/CrazyGames, where the same file is re-fetched over the network (subject
      // to the L0 boot-manifest budget, ASSET_PACKAGING §4) every session. Convention: any asset
      // that grows a same-directory `<name>.hires.<ext>` sibling automatically resolves to that
      // sibling on the `mobile` build only — every other target keeps importing the base (kept
      // deliberately compressed/small) file, and call sites never change. Purely opt-in: an asset
      // with no `.hires` sibling is completely unaffected on every target. First applied to
      // logo.png (497KB @512px, ~25% of the L0 boot budget) → a 129KB @256px default (plenty for
      // its actual ~150-160 design-px header display size) + a 1.9MB @1024px mobile-only sibling.
      ...(isMobile ? [
        new webpack.NormalModuleReplacementPlugin(
          /\.(png|jpe?g|webp)$/i,
          (resource) => {
            if (/\.hires\.[^.]+$/i.test(resource.request)) return; // already the hi-res file itself
            const hiresRequest = resource.request.replace(/(\.[^.]+)$/, '.hires$1');
            const abs = path.resolve(resource.context, hiresRequest);
            if (fs.existsSync(abs)) resource.request = hiresRequest;
          },
        ),
      ] : []),
      // Native-only Capacitor packages → no-op stubs on every non-mobile target. Mirror image of the
      // `.hires` swap above: same "one source tree, several targets" idiom, applied to code instead
      // of art. Capacitor's runtime only means anything inside the iOS shell, which loads the
      // `mobile` build alone, so on web/crazygames/wechat these packages are dead weight — but an
      // unconditional top-level `import` puts them in the graph regardless, and a bundler cannot know
      // that the *web* implementation they ship (a real browser-Notification-API one, in
      // local-notifications' case) is unreachable behind `Capacitor.isNativePlatform()`. Swapping the
      // request drops ~12 KB from three bundles at once; it matters most for wechat, the one with a
      // hard budget (main package ≤4 MB, ASSET_PACKAGING §4). Each stub documents the surface it
      // covers and the rule for extending it.
      // Scope: these two are what platform/localReminders.ts imports — the only unconditional
      // Capacitor import in the shared graph. platform/ota.ts (@capgo/capacitor-updater) is already
      // mobile-only by *reachability*: entries/mobile.ts is its sole importer, so the other entries
      // never pull it in. platform/nativeAds.ts / iap.ts have no package behind them at all — they
      // read `window.NWAds` / `window.NWBilling` globals injected by the shell. Add a row here (plus
      // a stub) if a native-only package ever joins the shared graph.
      ...(isMobile ? [] : [
        [/^@capacitor\/core$/, 'src/platform/stubs/capacitorCore.ts'],
        [/^@capacitor\/local-notifications$/, 'src/platform/stubs/localNotifications.ts'],
      ].map(([pkg, stub]) => new webpack.NormalModuleReplacementPlugin(
        pkg,
        path.resolve(__dirname, stub),
      ))),
      new webpack.DefinePlugin({
        TARGET: JSON.stringify(targetPlatform),
        'globalThis.__NW_API_BASE__': JSON.stringify(apiBase),
        'globalThis.__NW_GATEWAY_WS__': JSON.stringify(gatewayWs),
        'globalThis.__NW_BUILD_VERSION__': JSON.stringify(process.env.NW_BUILD_VERSION || '0.0.0'),
        'globalThis.__NW_WORLD_BASE__': JSON.stringify(worldBase),
        'globalThis.__NW_SOCIAL_BASE__': JSON.stringify(socialBase),
        'globalThis.__NW_AUCTION_BASE__': JSON.stringify(auctionBase),
      }),
    ],
    devServer: {
      static: [
        { directory: path.join(__dirname, 'dist'), publicPath: '/' },
        { directory: path.join(__dirname, 'src/assets'), publicPath: '/assets' },
      ],
      hot: true,
      open: true,
      port: 19090,
    },
    optimization: {
      minimize: isProd,
      // Keep the source names of Scene classes through minification. The anomaly channel stamps the
      // active scene on ANR reports via `SceneManager` reading `scene.constructor.name` — with default
      // terser mangling that name collapses to a 2-char alias (e.g. WorldMapScene→"hf", LobbyScene→"$t"),
      // making the `anr.scene` breadcrumb unreadable in Loki. Scoping keep_classnames to /Scene$/ preserves
      // exactly those names (all scenes end in "Scene") at negligible bundle cost, leaving every other
      // class mangled as before.
      minimizer: [new TerserPlugin({ terserOptions: { keep_classnames: /Scene$/ } })],
    },
  };
};
