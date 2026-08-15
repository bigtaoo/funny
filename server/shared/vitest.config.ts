import { defineConfig, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      exclude: [...coverageConfigDefaults.exclude],
    },
    // mongo.test.ts needs a real Mongo (createMongo + ensureXIndexes). globalSetup spins up a
    // standalone mongod via mongodb-memory-server (no transactions used here — a replica set is
    // unnecessary) unless NW_MONGO_URI points at an external DB; setupEnv bridges the URI into
    // each worker. The rest of the suite (pure-function unit tests) is unaffected.
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setupEnv.ts'],
    testTimeout: 15000,
    // First run may download the pinned mongod binary — give globalSetup room; cached runs are instant.
    hookTimeout: 120000,
  },
});
