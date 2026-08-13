import path from 'path';
import { defineConfig } from 'vitest/config';

// Bootstrap (see claudedocs/animator.md's 2026-08-13 note on scope) — covers the editor's PURE
// model layer (model/color.ts, model/EffectModel.ts, model/paramHints.ts). Anything that touches
// PIXI (rendering/*, ui/*) or the DOM (io/*, index.ts) is out of scope: those build a real
// PIXI.Application / call getElementById at import time, and this editor has no headless harness
// like client/test/harness/pixiHeadless.ts.
//
// Alias mirrors webpack.config.js + tsconfig.json's `@vfx` path — EffectModel.ts imports the
// EffectDef/LayerDef/etc. data model from there (game-side single source of truth).
export default defineConfig({
  resolve: {
    alias: {
      '@vfx': path.resolve(__dirname, '../../client/src/render/vfx'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
