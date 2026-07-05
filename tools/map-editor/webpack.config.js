const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

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
