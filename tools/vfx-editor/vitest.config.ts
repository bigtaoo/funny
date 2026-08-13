import path from 'path';
import { defineConfig } from 'vitest/config';

// Covers the editor's PURE model layer (model/color.ts, model/EffectModel.ts,
// model/paramHints.ts) plus io/{ProjectStore,Library}.ts — see claudedocs/animator.md's
// 2026-08-13 notes on scope. io/ProjectStore.ts is tested against a REAL (if in-memory)
// IndexedDB via the `fake-indexeddb` dev dependency; io/Library.ts stubs window/document/
// localStorage (vi.stubGlobal, same idiom as animator/test/fileIO.test.ts) and uses an in-memory
// stand-in store (see Library.test.ts's header comment for why — combining vi.useFakeTimers()
// with the real fake-indexeddb-backed store hangs). Anything that touches PIXI (rendering/*,
// ui/*) or the DOM at import time (index.ts) is still out of scope: this editor has no headless
// harness like client/test/harness/pixiHeadless.ts.
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
