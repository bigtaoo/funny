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
    resolve: { extensions: ['.ts', '.js', '.json'] },
    module: {
      rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
    },
    plugins: [new HtmlWebpackPlugin({ template: './public/index.html', inject: 'body' })],
    devServer: { static: './dist', hot: true, port: 9093, open: true },
    devtool: isDev ? 'eval-source-map' : false,
  };
};
