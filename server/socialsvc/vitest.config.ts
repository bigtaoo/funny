import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
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
