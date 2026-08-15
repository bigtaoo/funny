import path from 'path';
import { defineConfig } from 'vitest/config';
import { FlakyReporter } from '../scripts/flakyReporter.mjs';

// Load / capacity test — spins up N concurrent headless clients (real createAppCore)
// against a LIVE server stack and measures how many get through registration →
// gateway connect → ranked matchmaking within a deadline, reporting pairing latency.
//
// Opt-in only (`npm run test:load`) — needs the full stack running (meta + gateway +
// matchsvc + game + commercial + mongo), same prereq as the E2E. Tune the fleet size
// with NW_LOAD_CLIENTS (default 100); raise it later to probe a single server's
// real ceiling.
//
// Named *.load.ts so neither `npm test` nor `npm run test:e2e` picks it up.
export default defineConfig({
  resolve: {
    alias: {
      '@nw/engine': path.resolve(__dirname, '../server/engine/src'),
      // Card catalogue constants (roster cap / fusion) — mirrors vitest.e2e.config.ts.
      '@nw/shared/cards': path.resolve(__dirname, '../server/shared/src/cards.ts'),
      // Browser-safe slice, same as webpack.config.js/vitest.config.ts/vitest.e2e.config.ts —
      // NOT the full src/index.ts barrel, which re-exports jwt.ts (-> 'jsonwebtoken', a
      // server-only dep this job never `npm ci`s). See vitest.e2e.config.ts's comment.
      '@nw/shared': path.resolve(__dirname, '../server/shared/src/slg/index.ts'),
    },
  },
  test: {
    // CI stability (2026-08-15, see claudedocs/server.md "CI 稳定性"): one retry for the DB- and network-backed
    // suites. A single Mongo-driver / scheduler hiccup used to fail the whole run, and because every
    // *-deploy.yml gates on CI's overall conclusion, that meant an already-merged PR simply did not
    // deploy. Retries are NOT a way to live with flaky tests: FlakyReporter turns every
    // "failed then passed" into a ::warning:: annotation + flaky-report.json artifact, and the nightly
    // flake-hunt workflow re-runs these suites N times specifically to surface them. A test that
    // needs the retry is a bug to fix, and this makes it visible instead of invisible.
    retry: 1,
    reporters: ['default', new FlakyReporter('client-load')],
    include: ['test/load/**/*.load.ts'],
    environment: 'node',
    globals: false,
    // A fleet of 100+ clients takes a while to register + pair; give it room.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // One process: all clients share the matchmaking queue; serial keeps it clean.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
