const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  // Online workspace (Supabase) connection — injected at build time. Empty when
  // unset → the workspace UI disables itself; the editor still works offline.
  const supabaseUrl     = process.env.NW_SUPABASE_URL || '';
  const supabaseAnonKey = process.env.NW_SUPABASE_ANON_KEY || '';

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
      new webpack.DefinePlugin({
        __NW_SUPABASE_URL__:      JSON.stringify(supabaseUrl),
        __NW_SUPABASE_ANON_KEY__: JSON.stringify(supabaseAnonKey),
      }),
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
