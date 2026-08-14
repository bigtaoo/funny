import path from 'path';
import { defineConfig, coverageConfigDefaults } from 'vitest/config';

// Tests cover ONLY the pure game-logic core (@nw/engine + src/game/**), which has
// no PIXI dependency. Render-layer files are intentionally out of scope.
export default defineConfig({
  // @nw/engine resolves to its TS source (server/engine/src) — the engine moved
  // out of client into the workspace package (§16.7) and is imported directly;
  // the old src/game/* re-export shims were deleted (2026-08-02).
  // @nw/shared mirrors the webpack/tsconfig alias to the browser-safe SLG slice
  // (server/shared/src/slg/index.ts), NOT the node-only barrel.
  resolve: {
    alias: {
      '@nw/engine': path.resolve(__dirname, '../server/engine/src'),
      '@nw/shared/cards': path.resolve(__dirname, '../server/shared/src/cards.ts'),
      '@nw/shared': path.resolve(__dirname, '../server/shared/src/slg/index.ts'),
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
      // Mirrors the test `include` above and the file header comment: this suite only ever
      // exercises the pure game-logic core (src/game/**), never the PIXI render/UI/scene layers
      // (those have their own suites — test:ui/test:render/test:e2e). Scoping coverage.include
      // to match keeps the % honest instead of drowning it in 0%-covered render-layer files
      // this config was never meant to touch.
      include: ['src/game/**'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
