import path from 'path';
import { defineConfig } from 'vitest/config';

// Manual tuning dumps (test/*.manual.ts) — NOT regression tests: no expect() assertions, just
// console.log tables (per-level timeline inspector, difficulty-variant A/B comparisons) meant
// to be read by a human while tuning balance. Kept out of `test/**/*.test.ts` so they can't
// silently inflate `npm test`'s pass count or slow down the default suite (each loops
// thousands of ticks purely to print, see test/diag.manual.ts / test/experiment.manual.ts).
// Run explicitly with `npm run test:manual` (or vitest run --config vitest.manual.config.ts
// test/diag.manual.ts to target one file) when tuning difficulty.
export default defineConfig({
  resolve: {
    alias: { '@nw/engine': path.resolve(__dirname, '../server/engine/src') },
  },
  test: {
    name: 'manual',
    include: ['test/**/*.manual.ts'],
    environment: 'node',
    globals: false,
  },
});
