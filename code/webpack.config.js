const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const BrotliPlugin = require('brotli-webpack-plugin');
const webpack = require('webpack');
// const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';
  const targetPlatform = env.TARGET || 'web';

  // metaserver REST 基址 / gateway 控制面 WS：构建期注入全局，运行时 net/config.ts 读取。
  // 优先取环境变量（CI/生产用 NW_API_BASE=https://host/api）；dev 缺省指向本地 metaserver
  // （NW_META_PORT 默认 18080）+ gateway（NW_GW_PORT 默认 8082），开箱即可注册 / 联机。
  // 生产未配则留空 → net/config 返回 null → 退化为纯本地离线。
  const apiBase = process.env.NW_API_BASE || (isProd ? '' : 'http://localhost:18080');
  const gatewayWs = process.env.NW_GATEWAY_WS || (isProd ? '' : 'ws://localhost:8082/gw');

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
    resolve: { extensions: ['.ts', '.js'] },
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
