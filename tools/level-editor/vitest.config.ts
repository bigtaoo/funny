import path from 'path';
import { defineConfig } from 'vitest/config';

// Bootstrap only (see claudedocs/animator.md's 2026-08-13 note on scope) — covers the editor's
// PURE display-metadata layer (units.ts). Anything that touches PIXI (board/*, timeline/*) or the
// DOM (index.ts, inspector/*) is out of scope: those build a real PIXI.Application / call
// getElementById at import time, and this editor has no headless harness like
// client/test/harness/pixiHeadless.ts.
//
// Alias mirrors webpack.config.js + tsconfig.json's `@nw/engine` path.
export default defineConfig({
  resolve: {
    alias: {
      '@nw/engine': path.resolve(__dirname, '../../server/engine/src'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
