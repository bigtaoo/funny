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
// actual PIXI/DOM dependency despite living in otherwise-DOM-heavy files: Playback.ts (the preview
// clock — was already 100% pure, just needed a test; it lived in rendering/ then, see Phase 4c
// below) and ui/ParamPanel.ts's form-detection/lossy-conversion/sort helpers (formOf/firstValue/
// lastValue/sortKfs), exported (previously module-private). The rest of rendering/* and ui/*
// (PreviewRenderer's real `new PIXI.Application`, every panel's `document.createElement`-based
// construction) plus the DOM at import time (index.ts) remain out of scope: this editor has no
// headless harness like client/test/harness/pixiHeadless.ts.
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
      // ADR-070 Phase 4c (2026-08-20): the machine-readable form of the prose scope above, and now
      // GATED at 90% — 100% (529/529 lines, functions 76/80) at graduation, up from 84.9%
      // (449/529). Almost the whole gap was io/IOController.ts (74 lines, 0%), which stayed in
      // scope precisely because nothing structural was in its way: unlike the PIXI panels it needs
      // no harness, only tests, so "untested" there was a gap rather than a limit.
      // test/IOController.test.ts closed it; the last 6 lines were Library's autosave-failure and
      // no-crypto fallbacks plus ProjectStore's first-run onupgradeneeded (that one had never run
      // in a test because ProjectStore.test.ts's own reset creates the object store first — see
      // test/ProjectStoreFirstRun.test.ts). The 4 still-uncovered FUNCTIONS are IndexedDB's
      // onerror/onabort reject callbacks: reaching them means replacing fake-indexeddb with a mock
      // of the very API under test, which buys a number and loses the test. Line coverage is what
      // the gate reads, per the repo's existing convention.
      //
      // The include is two DIRECTORY entries. rendering/Playback.ts used to be listed here as a
      // third, per-file entry; Phase 4a's reading of that shape was "a per-file include is the
      // smell of a missing module boundary", and it held: Playback is editor STATE (t, playing,
      // duration — no PIXI, no canvas, no DOM), so it moved to src/model/Playback.ts and
      // src/rendering/ is now homogeneously the PIXI half (PreviewRenderer alone). Dependency
      // direction is one-way, model/ <- rendering/.
      //
      // What "in scope" means HERE is NOT "DOM-free" — src/io/** genuinely reaches for window,
      // document, localStorage, indexedDB, Blob and URL, and it should: persistence and file
      // exchange are its job. The line this package's scope actually draws is "runnable headless":
      // every browser API in scope has a real stand-in (fake-indexeddb for IndexedDB, vi.stubGlobal
      // for the rest, Node's own Blob/URL), whereas `new PIXI.Application` does not. So the purity
      // guard next door is two-tier: src/model/** must stay DOM-free outright, src/io/** may use
      // only an explicitly listed set of browser globals. See test/pureLayerBoundary.test.ts — the
      // 90% gate cannot guard this boundary on its own: its headroom is covered/0.9 - total = 58
      // lines here, and a 5-line DOM probe dropped into src/model/ was measured at 99.06% with the
      // gate still green (the guard caught it).
      //
      // Still out of scope: rendering/PreviewRenderer.ts, all of ui/* (including ParamPanel.ts,
      // whose four pure exported helpers — formOf/firstValue/lastValue/sortKfs — are embedded in a
      // 194-line DOM panel that no directory include can split), and index.ts.
      include: ['src/model/**', 'src/io/**'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
