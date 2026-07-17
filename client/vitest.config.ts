import path from 'path';
import { defineConfig } from 'vitest/config';

// Tests cover ONLY the pure game-logic core (src/game/**), which has no PIXI
// dependency. Render-layer files are intentionally out of scope.
export default defineConfig({
  // @nw/engine resolves to its TS source (server/engine/src) — the engine moved
  // out of client into the workspace package (§16.7); the game/* shims re-export it.
  // @nw/shared mirrors the webpack/tsconfig alias to the browser-safe SLG slice
  // (server/shared/src/slg/index.ts), NOT the node-only barrel.
  resolve: {
    alias: {
      '@nw/engine': path.resolve(__dirname, '../server/engine/src'),
      '@nw/shared': path.resolve(__dirname, '../server/shared/src/slg/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
