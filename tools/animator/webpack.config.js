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
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
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
      port: 9091,
      open: true,
    },
    devtool: isDev ? 'eval-source-map' : false,
  };
};
