import { defineConfig, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // scripts/** are one-off migration/codegen tools, not app code (same precedent as
      // gameserver/metaserver's coverage.exclude for their scripts/**).
      exclude: [...coverageConfigDefaults.exclude, 'src/generated/**', 'scripts/**'],
    },
    // e2e tests need a real Mongo (rs0). globalSetup spins one up via mongodb-memory-server
    // unless NW_MONGO_URI points at an external DB; setupEnv bridges the URI into each worker.
    // Serial execution prevents cross-test DB races.
    fileParallelism: false,
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setupEnv.ts'],
    testTimeout: 15000,
    // First run may download the pinned mongod binary — give globalSetup room; cached runs are instant.
    hookTimeout: 120000,
  },
});
