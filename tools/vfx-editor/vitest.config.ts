import path from 'path';
import { defineConfig } from 'vitest/config';

// Phase 1-2 covered the editor's PURE model layer (model/color.ts, model/EffectModel.ts,
// model/paramHints.ts) plus io/{ProjectStore,Library}.ts — see claudedocs/animator.md's
// 2026-08-13 notes on scope. io/ProjectStore.ts is tested against a REAL (if in-memory)
// IndexedDB via the `fake-indexeddb` dev dependency; io/Library.ts stubs window/document/
// localStorage (vi.stubGlobal, same idiom as animator/test/fileIO.test.ts) and uses an in-memory
// stand-in store (see Library.test.ts's header comment for why — combining vi.useFakeTimers()
// with the real fake-indexeddb-backed store hangs).
//
// Phase 4 (2026-08-13, tools-test-coverage-plan memory) added two more pure seams that had no
// actual PIXI/DOM dependency despite living in otherwise-DOM-heavy files: rendering/Playback.ts
// (the preview clock — was already 100% pure, just needed a test) and ui/ParamPanel.ts's
// form-detection/lossy-conversion/sort helpers (formOf/firstValue/lastValue/sortKfs), exported
// (previously module-private). The rest of rendering/* and ui/* (PreviewRenderer's real
// `new PIXI.Application`, every panel's `document.createElement`-based construction) plus the
// DOM at import time (index.ts) remain out of scope: this editor has no headless harness like
// client/test/harness/pixiHeadless.ts.
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
