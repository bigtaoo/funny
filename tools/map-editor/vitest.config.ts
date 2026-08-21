import path from 'path';
import { defineConfig, coverageConfigDefaults } from 'vitest/config';

// Tests cover the editor's PURE layers only — camera math, hit-testing, the terrain/city stores,
// the iso projection, tile styling and i18n. Anything that touches PIXI (`stage.ts`, `render/*`)
// or the DOM (`dom.ts`, `ui/*`, `input/*`) is deliberately out of scope: those modules build a
// real PIXI.Application / call getElementById at import time, and the editor has no headless
// harness like client/test/harness/pixiHeadless.ts.
//
// The alias mirrors webpack.config.js + tsconfig.json: `@nw/shared/slg` resolves straight to
// server/shared TS source (the `@nw/shared` barrel is Node-only and would break the browser build).
export default defineConfig({
  resolve: {
    alias: {
      '@nw/shared/slg': path.resolve(__dirname, '../../server/shared/src/slg/index.ts'),
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
      // ADR-070 (2026-08-20): the machine-readable form of the prose scope above — "camera math,
      // hit-testing, the terrain/city stores, the iso projection, tile styling and i18n". 100.0%
      // (652/652) lines and 62/62 functions as of 2026-08-20, and every covered line in the whole
      // package falls inside this list, i.e. the scope matches what the suite actually exercises
      // rather than being drawn around it after the fact. The uncovered BRANCHES that remain
      // (camera.ts's map-smaller-than-viewport arms of clampPan, tileStyle.ts's `??` fallbacks on
      // its palette lookups) are unreachable with a 1500x1500 map and valid TileTypes; the gate is
      // on lines only, by long-standing convention (see checkCoverageThreshold.mjs's header).
      //
      // Phase 4a (same day) made this list purely directory/whole-file level and put the package
      // under the 90% gate (it moved from NOT_GATED_JSON_SUMMARY_PACKAGES to
      // JSON_SUMMARY_PACKAGES in scripts/coverageLib.mjs). What used to be here was
      // `src/render/{isoGrid,tileStyle}.ts` — two pure files named one at a time because they sat
      // in a directory otherwise full of PIXI drawing and atlas loaders (tileGraphics/baseMap/
      // overlay/citySprites/refresh/*Loader, all 0%), so `src/render/**` would have dragged the
      // scope down to ~25%. That per-file list was the missing module boundary talking; the two
      // files now live in `src/tiles/` (the pure "where is this tile / what does it look like"
      // layer, no PIXI, no DOM) and `src/render/` is uniformly the PIXI half. Out of scope:
      // render/*, ui/*, input/*, api.ts, dom.ts, stage.ts, editor.ts, index.ts.
      //
      // The boundary itself is pinned by test/pureLayerBoundary.test.ts, NOT by this percentage.
      // The first version of this note claimed the gate did it — that a PIXI module dropped into an
      // included directory lands there at ~0% and fails the 90% bar. Measured, that is false for
      // most real cases: at 652/652 there is `652/0.9 - 652` = 72 lines of headroom, and 10 of this
      // package's 16 PIXI/DOM files are smaller than that (every atlas loader, refresh.ts,
      // citySprites.ts, viewport.ts, status.ts, i18nApply.ts, panels.ts). Verified by actually
      // dropping a 13-line PIXI+DOM module into src/tiles/: coverage 96.98%, gate PASSES. Worse,
      // the headroom GROWS as these tests improve. So the percentage gate and the purity guard are
      // two separate jobs, and pureLayerBoundary.test.ts derives the directories it checks from
      // this very include list, so adding a third one here fails until it is guarded too.
      include: ['src/state/**', 'src/tiles/**', 'src/i18n.ts', 'src/constants.ts'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
