const path = require('path');
const { execSync } = require('child_process');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');

function gitCommit() {
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
    // Check only ops-related files for uncommitted changes → mark -dirty (avoids false-dirty from parallel changes elsewhere in the repo).
    const root = execSync('git rev-parse --show-toplevel', { cwd: __dirname }).toString().trim();
    const dirty = execSync(
      'git status --porcelain -- tools/ops wrangler.ops.jsonc worker.ops.js',
      { cwd: root },
    ).toString().trim().length > 0;
    return dirty ? `${hash}-dirty` : hash;
  } catch {
    return 'unknown';
  }
}

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';
  const buildVersion = gitCommit();
  const buildTime = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return {
    entry: './src/index.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'bundle.[contenthash].js',
      clean: true,
    },
    resolve: { extensions: ['.ts', '.js', '.json'] },
    module: {
      rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
    },
    plugins: [
      new HtmlWebpackPlugin({ template: './public/index.html', inject: 'body' }),
      new webpack.DefinePlugin({
        __BUILD_VERSION__: JSON.stringify(buildVersion),
        __BUILD_TIME__: JSON.stringify(buildTime),
      }),
    ],
    devServer: { static: './dist', hot: true, port: 9093, open: true },
    devtool: isDev ? 'eval-source-map' : false,
  };
};
