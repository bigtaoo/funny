import { defineConfig, coverageConfigDefaults } from 'vitest/config';
import { FlakyReporter } from '../../scripts/flakyReporter.mjs';

export default defineConfig({
  test: {
    // CI stability (2026-08-15, see claudedocs/server.md "CI 稳定性"): one retry for the DB- and network-backed
    // suites. A single Mongo-driver / scheduler hiccup used to fail the whole run, and because every
    // *-deploy.yml gates on CI's overall conclusion, that meant an already-merged PR simply did not
    // deploy. Retries are NOT a way to live with flaky tests: FlakyReporter turns every
    // "failed then passed" into a ::warning:: annotation + flaky-report.json artifact, and the nightly
    // flake-hunt workflow re-runs these suites N times specifically to surface them. A test that
    // needs the retry is a bug to fix, and this makes it visible instead of invisible.
    retry: 1,
    reporters: ['default', new FlakyReporter('auctionsvc')],
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      exclude: [...coverageConfigDefaults.exclude, 'src/generated/**'],
    },
    // Skeleton has no multi-doc transactions — a standalone mongod is sufficient (mirrors analyticsvc).
    fileParallelism: false,
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setupEnv.ts'],
    testTimeout: 15000,
    hookTimeout: 120000,
  },
});
