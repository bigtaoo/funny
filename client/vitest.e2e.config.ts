import path from 'path';
import { defineConfig } from 'vitest/config';

// Full-link E2E: drives the REAL client orchestration (createAppCore) headlessly
// against a live local server stack (meta + gateway + matchsvc + game + commercial
// + mongo). Opt-in only — `npm run test:e2e` — because it needs those processes
// running (see server/dev-up.ps1 / docker compose). Named *.e2e.ts so the default
// `npm test` (test/**/*.test.ts) never picks it up.
export default defineConfig({
  resolve: { alias: { '@nw/engine': path.resolve(__dirname, '../server/engine/src') } },
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 40_000,
    hookTimeout: 40_000,
    // One worker: the two headless clients share this process; serial keeps the
    // server-side matchmaking queue unambiguous across tests.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
