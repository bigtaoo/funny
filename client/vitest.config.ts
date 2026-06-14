import { defineConfig } from 'vitest/config';

// Tests cover ONLY the pure game-logic core (src/game/**), which has no PIXI
// dependency. Render-layer files are intentionally out of scope.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
