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
        // Single source of truth: the editor imports the game's pure-data level
        // schema / constants directly (see tools/level-editor/DESIGN.md §6.5).
        '@game': path.resolve(__dirname, '../../client/src/game'),
        // @game shims re-export from @nw/engine — wire up the same alias.
        '@nw/engine$': path.resolve(__dirname, '../../server/engine/src/index.ts'),
        '@nw/engine': path.resolve(__dirname, '../../server/engine/src'),
      },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          // transpileOnly: the shared game files are already type-checked by the
          // game's own tsc/CI. Skipping cross-project type-checking here avoids
          // pulling the whole i18n TranslationKey union into the editor build.
          use: { loader: 'ts-loader', options: { transpileOnly: true } },
          exclude: /node_modules/,
        },
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
      port: 9092,
      open: true,
    },
    devtool: isDev ? 'eval-source-map' : false,
  };
};
