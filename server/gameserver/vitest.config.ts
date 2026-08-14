import { defineConfig, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure logic unit tests (Room / RoomManager); no Mongo or real WS needed: inject a fake Connection.
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      exclude: [...coverageConfigDefaults.exclude, 'src/generated/**'],
    },
  },
});
