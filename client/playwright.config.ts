import { defineConfig, devices } from '@playwright/test';

// Browser smoke config (claudedocs/client-testing.md 缺口B). Independent from vitest.config —
// this is the only layer that drives a real renderer / real WebGL. Opt-in (`npm run test:browser`),
// never part of the default `npm test`.
export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  // One retry in CI only — this test hits a real network/live stack (register/room/matchmaking),
  // so a single transient timing hiccup shouldn't count as a real regression the way it would in
  // the deterministic headless suites. Local runs get zero retries (a real bug should reproduce
  // immediately, not need a second try to notice).
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://localhost:9096',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run start:e2e',
    url: 'http://localhost:9096',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
