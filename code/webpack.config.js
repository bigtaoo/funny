const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const BrotliPlugin = require('brotli-webpack-plugin');
const webpack = require('webpack');
// const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';
  const targetPlatform = env.TARGET || 'web';

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
