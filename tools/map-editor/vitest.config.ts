import path from 'path';
import { defineConfig, coverageConfigDefaults } from 'vitest/config';

// Tests cover the editor's PURE layers only — camera math, hit-testing, the terrain/city stores,
// the iso projection, tile styling and i18n. Anything that touches PIXI (`stage.ts`, `render/*`
// drawing) or the DOM (`dom.ts`, `ui/*`, `input/*`) is deliberately out of scope: those modules
// build a real PIXI.Application / call getElementById at import time, and the editor has no
// headless harness like client/test/harness/pixiHeadless.ts.
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
      // hit-testing, the terrain/city stores, the iso projection, tile styling and i18n". 98.8%
      // (644/652) as of 2026-08-20, and every covered line in the whole package falls inside this
      // list, i.e. the scope matches what the suite actually exercises rather than being drawn
      // around it after the fact.
      //
      // The two FILE-level entries under render/ are a smell, not a preference: isoGrid.ts and
      // tileStyle.ts are pure math/styling that happen to sit in a directory otherwise full of
      // PIXI drawing and atlas loaders (tileGraphics/baseMap/overlay/citySprites/refresh/*Loader,
      // all 0%), so `src/render/**` would drag the scope down to ~25% and a per-file list is the
      // only way to say what is meant. ADR-070's Phase 4a moves them into their own pure module so
      // this can go back to being directory-level. Out of scope: that drawing half of render/,
      // plus ui/*, input/*, api.ts, dom.ts, stage.ts, editor.ts, index.ts.
      include: ['src/state/**', 'src/render/isoGrid.ts', 'src/render/tileStyle.ts', 'src/i18n.ts', 'src/constants.ts'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
