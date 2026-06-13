import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 端到端测试需真实 Mongo（docker compose up -d）；串行避免跨用例 DB 竞态。
    fileParallelism: false,
    testTimeout: 15000,
  },
});
