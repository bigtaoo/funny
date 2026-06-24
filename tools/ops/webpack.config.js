const path = require('path');
const { execSync } = require('child_process');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
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
