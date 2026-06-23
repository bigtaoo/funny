const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');
// const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';
  const targetPlatform = env.TARGET || 'web';

  // metaserver REST 基址 / gateway 控制面 WS：构建期注入全局，运行时 net/config.ts 读取。
  // 优先取环境变量（CI/生产用 NW_API_BASE=https://host/api）；dev 缺省指向本地 metaserver
  // （NW_META_PORT 默认 18080）+ gateway（NW_GW_PORT 默认 8086），开箱即可注册 / 联机。
  // 注意：8082/8083 在本机 Windows TCP excludedportrange 内（WinNAT/Hyper-V 动态保留），
  // 绑定会 EACCES，故 gateway 改用 8086（须与 dev-up.ps1 的 NW_GW_PORT / NW_GATEWAY_PUBLIC_WS_URL 一致）。
  // 生产未配则留空 → net/config 返回 null → 退化为纯本地离线。
  const apiBase = process.env.NW_API_BASE || (isProd ? '' : 'http://localhost:18080');
  const gatewayWs = process.env.NW_GATEWAY_WS || (isProd ? '' : 'ws://localhost:8086/gw');
  const worldBase = process.env.NW_WORLD_BASE || (isProd ? '' : 'http://localhost:18084');

  return {
    target: 'web',
    mode: isProd ? 'production' : 'development',
    entry: `./src/entries/${targetPlatform}.ts`,
    devtool: isProd ? false : 'source-map',
    module: {
      rules: [
        { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
        {
          test: /\.(png|jpg|gif|webp|mp3|wav|ogg|tao)$/i,
          type: 'asset/resource',
          // generator: {
          //     'assets/[name].[contenthash][ext]'
          // },
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
        // @nw/shared = shared types + proceduralTile (pure, deterministic).
        // Client uses proceduralTile to render background terrain without a server round-trip.
        '@nw/shared': path.resolve(__dirname, '../server/shared/src/index.ts'),
      },
    },
    output: {
      filename: 'index.js',
      path: path.resolve(__dirname, 'dist'),
      clean: true,
    },
    plugins: [
      new HtmlWebpackPlugin({ template: `./public/${targetPlatform}/index.html` }),
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
