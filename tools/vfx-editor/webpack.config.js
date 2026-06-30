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
      // Resolve bare deps (pixi.js-legacy) from THIS tool's node_modules even when
      // the import originates in the shared client/ source subtree (whose own
      // node_modules isn't present in a worktree checkout).
      modules: [path.resolve(__dirname, 'node_modules'), 'node_modules'],
      alias: {
        // Single source of truth: the editor imports the game's vfx interpreter /
        // types / validator directly (DESIGN §8 reuse rationale). Never a second copy.
        '@vfx': path.resolve(__dirname, '../../client/src/render/vfx'),
        '@game': path.resolve(__dirname, '../../client/src/game'),
        // The game's prng re-export shim points at @nw/engine — wire it up so the
        // interpreter's seeded randomness resolves (same as level-editor).
        '@nw/engine$': path.resolve(__dirname, '../../server/engine/src/index.ts'),
        '@nw/engine': path.resolve(__dirname, '../../server/engine/src'),
      },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          // transpileOnly: the shared game files are type-checked by the game's
          // own tsc/CI; skipping cross-project checks here keeps the build fast
          // and avoids pulling unrelated game type graphs into the editor.
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
      port: 9094,
      open: true,
    },
    devtool: isDev ? 'eval-source-map' : false,
  };
};
