const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');
// const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';
  const targetPlatform = env.TARGET || 'web';
  const isWechat = targetPlatform === 'wechat';

  // metaserver REST 基址 / gateway 控制面 WS：构建期注入全局，运行时 net/config.ts 读取。
  // 优先取环境变量（CI/生产用 NW_API_BASE=https://host/api）；dev 缺省指向本地 metaserver
  // （NW_META_PORT 默认 18080）+ gateway（NW_GW_PORT 默认 8086），开箱即可注册 / 联机。
  // 注意：8082/8083 在本机 Windows TCP excludedportrange 内（WinNAT/Hyper-V 动态保留），
  // 绑定会 EACCES，故 gateway 改用 8086（须与 dev-up.ps1 的 NW_GW_PORT / NW_GATEWAY_PUBLIC_WS_URL 一致）。
  // 生产未配则留空 → net/config 返回 null → 退化为纯本地离线。
  const apiBase = process.env.NW_API_BASE || (isProd ? '' : 'http://localhost:18080');
  const gatewayWs = process.env.NW_GATEWAY_WS || (isProd ? '' : 'ws://localhost:8086/gw');
  const worldBase = process.env.NW_WORLD_BASE || (isProd ? '' : 'http://localhost:18084');
  // 微信小游戏方案 A 资源 CDN 基址（ASSET_PACKAGING §4）。微信构建专用：asset/resource 的
  // publicPath 设成它，import 直接烘焙成 `<CDN>/cdn/<hash>.png` 绝对 URL，资源文件发到 wechatgame/cdn/
  // （由 project.config packOptions.ignore 排除出主包，单独上传 CDN）。留空则退化为包内相对路径（整包跑，
  // 仅本地 IDE 自测用）。Web/CrazyGames 忽略此项（同源相对 URL）。
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
          // 微信（方案 A）：资源发到 cdn/ 子目录并把 URL 烘焙成 CDN 绝对地址；运行时 WechatAssetIO
          // downloadFile + 本地缓存（微信无 fetch）。Web/CrazyGames：默认行为（dist 根 + 同源相对 URL）。
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
      // 微信壳层 game.js 里 `require('./pixigame.js')`：单 IIFE 包，自执行。clean:false 保住
      // 同目录的 game.js/game.json/assets/。globalObject=globalThis 适配微信运行时（无 window/self）。
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
      // 微信无 HTML 宿主（game.js require pixigame.js）；HtmlWebpackPlugin / version.json / _headers 仅 Web。
      ...(isWechat ? [] : [new HtmlWebpackPlugin({ template: `./public/${targetPlatform}/index.html` })]),
      // 构建时写出 version.json（客户端轮询版本用）和 _headers（CF Workers / nginx 缓存策略）。
      ...(isProd && !isWechat ? [{
        apply(compiler) {
          const version = process.env.NW_BUILD_VERSION || '0.0.0';
          compiler.hooks.thisCompilation.tap('StaticMetaPlugin', (compilation) => {
            compilation.hooks.processAssets.tap(
              { name: 'StaticMetaPlugin', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
              () => {
                compilation.emitAsset('version.json', new webpack.sources.RawSource(JSON.stringify({ v: version })));
                // _headers：Cloudflare Workers static assets 支持此文件控制响应头。
                // index.html / version.json 不缓存，JS 文件带 contenthash 可永久缓存。
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
