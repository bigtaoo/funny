import path from 'path';
import { defineConfig } from 'vitest/config';

// Whole-battle simulation suites: test/difficulty/ch1-6 (+ its core.test.ts) and pvpSim. Split out
// of vitest.config.ts on 2026-08-15 — same tests, same assertions, just run WITHOUT v8 coverage
// instrumentation.
//
// Why: these files run complete headless battles (many thousands of engine ticks each), so they are
// ~175s of the suite's 188s wall clock, and under `--coverage` they blow up to ~10 minutes on their
// own — the entire reason the old CI ran coverage on push-to-main but not on PRs, which is what let
// a coverage regression (and, more importantly, a timing-sensitive flake) land on main after a green
// PR. Measured: dropping them from the coverage run moves client line coverage by 0.05pp
// (91.20% → 91.15%), because everything they exercise in `src/game/**` is already covered by the
// unit suites — they are a BEHAVIOURAL/balance check ("is chapter 6 still winnable, is the PvP sim
// still in range"), not a coverage source.
//
// They still run on every `npm test` / `npm run test:coverage` (both chain this config), and on
// every CI event. Nothing is skipped; only the instrumentation is.
export default defineConfig({
  resolve: {
    alias: {
      '@nw/engine': path.resolve(__dirname, '../server/engine/src'),
      '@nw/shared/cards': path.resolve(__dirname, '../server/shared/src/cards.ts'),
      '@nw/shared': path.resolve(__dirname, '../server/shared/src/slg/index.ts'),
    },
  },
  test: {
    include: ['test/difficulty/**/*.test.ts', 'test/pvpSim.test.ts'],
    environment: 'node',
    globals: false,
  },
});
