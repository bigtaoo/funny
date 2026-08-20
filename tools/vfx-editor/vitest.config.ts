import path from 'path';
import { defineConfig, coverageConfigDefaults } from 'vitest/config';

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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // ADR-070 (2026-08-20): the machine-readable form of the prose scope above. 84.9%
      // (449/529) as of 2026-08-20 — short of the 90% bar, and deliberately so: io/IOController.ts
      // (74 lines, 0%) stays IN scope even though it is pure assembly glue, because unlike
      // animator's DOM/PIXI panels it has no browser dependency standing in the way, so "untested"
      // here is a gap rather than a structural limit. Closing it is ADR-070's Phase 4c.
      //
      // rendering/Playback.ts is listed per-file for the same reason map-editor lists two files
      // under render/: it is 100%-pure preview-clock math sharing a directory with
      // PreviewRenderer.ts's real `new PIXI.Application`. Out of scope: that renderer, all of ui/*
      // (including ParamPanel.ts, whose four pure exported helpers — formOf/firstValue/lastValue/
      // sortKfs — are embedded in a 194-line DOM panel that no directory include can split), and
      // index.ts.
      include: ['src/model/**', 'src/io/**', 'src/rendering/Playback.ts'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
