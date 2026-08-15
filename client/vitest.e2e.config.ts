import path from 'path';
import { defineConfig } from 'vitest/config';
import { FlakyReporter } from '../scripts/flakyReporter.mjs';

// Full-link E2E: drives the REAL client orchestration (createAppCore) headlessly
// against a live local server stack (meta + gateway + matchsvc + game + commercial
// + mongo). Opt-in only — `npm run test:e2e` — because it needs those processes
// running (see server/dev-up.ps1 / docker compose). Named *.e2e.ts so the default
// `npm test` (test/**/*.test.ts) never picks it up.
export default defineConfig({
  resolve: {
    alias: {
      '@nw/engine': path.resolve(__dirname, '../server/engine/src'),
      // Auction full-link block imports shared auction constants (durations / tax rate).
      // Map the deep auction module BEFORE the barrel so the barrel's server-only
      // re-exports (jwt.ts -> jsonwebtoken) are never pulled into the client test.
      '@nw/shared/slg/auction': path.resolve(__dirname, '../server/shared/src/slg/auction.ts'),
      // Card catalogue constants (roster cap / fusion). Map before the barrel, same
      // reasoning as the auction alias above.
      '@nw/shared/cards': path.resolve(__dirname, '../server/shared/src/cards.ts'),
      // Browser-safe slice, same as webpack.config.js/vitest.config.ts — NOT the full
      // src/index.ts barrel, which re-exports jwt.ts (-> 'jsonwebtoken', a server-only
      // dep this job never `npm ci`s — see "bring up server stack" above, host-side only
      // installs client/). createAppCore's scene graph pulls in plenty of bare '@nw/shared'
      // imports (e.g. render/emblemIcon.ts); everything current resolves under slg/*, so
      // this covers them all — a future non-slg, non-cards, non-auction export needs its
      // own deep alias here rather than widening this one back to the full barrel.
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
    reporters: ['default', new FlakyReporter('client-e2e')],
    include: ['test/e2e/**/*.e2e.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 40_000,
    hookTimeout: 40_000,
    // One worker: the two headless clients share this process; serial keeps the
    // server-side matchmaking queue unambiguous across tests.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
