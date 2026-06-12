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
        // Single source of truth: the editor imports the game's pure-data level
        // schema / constants directly (see tools/level-editor/DESIGN.md §6.5).
        '@game': path.resolve(__dirname, '../../code/src/game'),
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
