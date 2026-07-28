const path = require('path');
const crypto = require('crypto');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// 供桌面壳（tools/desktop-shell）内容级热更新轮询用，见 design/tools/desktop-shell/DESIGN.md §4.2。
// 产出 version.json = 对本次构建全部资源文件名+大小的组合哈希（webpack contenthash 文件名一变，哈希就变）。
class VersionManifestPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('VersionManifestPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: 'VersionManifestPlugin', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
        (assets) => {
          const hash = crypto.createHash('sha256');
          for (const name of Object.keys(assets).sort()) {
            hash.update(name);
            hash.update(String(assets[name].size()));
          }
          const manifest = JSON.stringify({ hash: hash.digest('hex').slice(0, 16), builtAt: new Date().toISOString() });
          compilation.emitAsset('version.json', new webpack.sources.RawSource(manifest));
        }
      );
    });
  }
}

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  return {
    entry: './src/index.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'bundle.[contenthash].js',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.js', '.json'],
      alias: {
        // Single source of truth: the editor imports the map-generation module straight from
        // server/shared source (see tools/map-editor/DESIGN.md). Aliased to the `slg` submodule
        // specifically, not the @nw/shared barrel — the barrel also pulls in mongo/jwt/etc which
        // are Node-only and would break (or needlessly bloat) a browser bundle.
        '@nw/shared/slg': path.resolve(__dirname, '../../server/shared/src/slg/index.ts'),
      },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: { loader: 'ts-loader', options: { transpileOnly: true } },
          exclude: /node_modules/,
        },
        // Atlas PNGs (webpack5 asset module, matching client/webpack.config.js — not url-loader).
        { test: /\.png$/, type: 'asset/resource' },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './public/index.html',
        inject: 'body',
      }),
      new VersionManifestPlugin(),
    ],
    devServer: {
      static: './dist',
      hot: true,
      port: 9095,
      open: true,
    },
    devtool: isDev ? 'eval-source-map' : false,
  };
};
