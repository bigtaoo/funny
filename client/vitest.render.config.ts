import path from 'path';
import { defineConfig } from 'vitest/config';

// Render-layer tests: imports pixi.js-legacy and webpack-served assets, both
// stubbed by vi.mock() in each test file. Separate config keeps the main
// game-logic suite (vitest.config.ts) free of PIXI dependencies.
export default defineConfig({
  resolve: {
    alias: { '@nw/engine': path.resolve(__dirname, '../server/engine/src') },
  },
  test: {
    name: 'render',
    include: ['test/render/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
