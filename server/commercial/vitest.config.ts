import { defineConfig, coverageConfigDefaults } from 'vitest/config';
import { FlakyReporter } from '../../scripts/flakyReporter.mjs';

export default defineConfig({
  test: {
    // CI stability (2026-08-15, see claudedocs/server.md "CI 稳定性"): one retry for the DB/网络-backed
    // suites. A single Mongo-driver / scheduler hiccup used to fail the whole run, and because every
    // *-deploy.yml gates on CI's overall conclusion, that meant an already-merged PR simply did not
    // deploy. Retries are NOT a way to live with flaky tests: FlakyReporter turns every
    // "failed then passed" into a ::warning:: annotation + flaky-report.json artifact, and the nightly
    // flake-hunt workflow re-runs these suites N times specifically to surface them. A test that
    // needs the retry is a bug to fix, and this makes it visible instead of invisible.
    retry: 1,
    reporters: ['default', new FlakyReporter('commercial')],
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      exclude: [...coverageConfigDefaults.exclude, 'src/generated/**'],
    },
    // e2e tests need a real Mongo. globalSetup spins up a standalone mongod via
    // mongodb-memory-server (commercial uses only single-document atomic ops — no
    // multi-doc transactions — so a replica set is unnecessary) unless NW_MONGO_URI
    // points at an external DB; setupEnv bridges the URI into each worker.
    // Serial execution prevents cross-test DB races.
    fileParallelism: false,
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setupEnv.ts'],
    testTimeout: 15000,
    // First run may download the pinned mongod binary — give globalSetup room; cached runs are instant.
    hookTimeout: 120000,
  },
});
