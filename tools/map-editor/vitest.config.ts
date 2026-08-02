import path from 'path';
import { defineConfig } from 'vitest/config';

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
  },
});
