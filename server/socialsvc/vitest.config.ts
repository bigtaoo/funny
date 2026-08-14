import { defineConfig, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // scripts/migrateFamily.ts + migrateSocial.ts are one-shot migration tools (invoked manually,
      // never imported by app code or tests) — same rationale as excluding src/generated/**, its
      // output. Precedent: gameserver/metaserver/gateway/botsvc/auctionsvc's vitest.config.ts.
      exclude: [...coverageConfigDefaults.exclude, 'src/generated/**', 'scripts/**'],
    },
    // e2e tests need a real Mongo. globalSetup spins up a standalone mongod via
    // mongodb-memory-server (socialsvc uses only single-document atomic ops — no
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
