import { defineConfig, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // scripts/gen-proto.mjs is a one-shot codegen tool (invoked by `npm run proto:gen`, never imported
      // by app code or tests) — same rationale as excluding src/generated/**, its output. Precedent:
      // gameserver/vitest.config.ts.
      exclude: [...coverageConfigDefaults.exclude, 'src/generated/**', 'scripts/**'],
    },
  },
});
