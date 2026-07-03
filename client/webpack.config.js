const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

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
        // @nw/shared = browser-safe slice of server/shared. Points directly to slg.ts
        // (pure/deterministic, no Node.js built-ins) to avoid pulling in password/logger
        // which import node:crypto / node:fs / node:path and break webpack browser builds.
        '@nw/shared': path.resolve(__dirname, '../server/shared/src/slg.ts'),
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
    } : {
      filename: isProd ? '[contenthash].js' : 'index.js',
      path: path.resolve(__dirname, 'dist'),
      clean: true,
    },
    plugins: [
      // WeChat has no HTML host (game.js requires pixigame.js); HtmlWebpackPlugin / version.json / _headers are Web-only.
      ...(isWechat ? [] : [new HtmlWebpackPlugin({ template: `./public/${targetPlatform}/index.html` })]),
      // Copy legal pages (terms/privacy/refunds) + branding icons (favicon / apple-touch /
      // PWA manifest, referenced by <link> in the HTML templates) to dist root.
      ...(!isWechat ? [new CopyPlugin({ patterns: [
        { from: 'public/web/terms.html' }, { from: 'public/web/privacy.html' }, { from: 'public/web/refunds.html' }, { from: 'public/web/pricing.html' },
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
      new webpack.DefinePlugin({
        TARGET: JSON.stringify(targetPlatform),
        'globalThis.__NW_API_BASE__': JSON.stringify(apiBase),
        'globalThis.__NW_GATEWAY_WS__': JSON.stringify(gatewayWs),
        'globalThis.__NW_BUILD_VERSION__': JSON.stringify(process.env.NW_BUILD_VERSION || '0.0.0'),
        'globalThis.__NW_WORLD_BASE__': JSON.stringify(worldBase),
        'globalThis.__NW_SOCIAL_BASE__': JSON.stringify(socialBase),
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
    },
  };
};
