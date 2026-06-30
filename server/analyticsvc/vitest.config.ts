import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // e2e tests require a real Mongo (docker compose up -d); serial execution prevents cross-test DB races.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
