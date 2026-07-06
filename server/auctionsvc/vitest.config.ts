import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Skeleton has no multi-doc transactions — a standalone mongod is sufficient (mirrors analyticsvc).
    fileParallelism: false,
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setupEnv.ts'],
    testTimeout: 15000,
    hookTimeout: 120000,
  },
});
