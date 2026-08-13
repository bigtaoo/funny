import { defineConfig, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
  test: {
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
