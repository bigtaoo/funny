const resolve = require('@rollup/plugin-node-resolve').default;
const commonjs = require('@rollup/plugin-commonjs');
const typescript = require('@rollup/plugin-typescript');
const polyfillNode = require('rollup-plugin-polyfill-node');
const json = require('@rollup/plugin-json');

module.exports = {
  input: 'src/wechatIndex.ts',
  output: {
    file: 'wechatgame/pixigame.js',
    format: 'iife',
    name: 'game',
    sourcemap: true,
  },
  plugins: [
    polyfillNode(),
    resolve({
      browser: true,
      preferBuiltins: false,
    }),
    commonjs(),
    json(),
    typescript(),
  ],
};
