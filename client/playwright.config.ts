import { defineConfig, devices } from '@playwright/test';
import { LOCAL_STACK_SPECS } from './playwright.portrait.config';

// Browser smoke config (claudedocs/client-testing.md 缺口B). Independent from vitest.config —
// this is the only layer that drives a real renderer / real WebGL. Opt-in (`npm run test:browser`),
// never part of the default `npm test`; a hard step of ci.yml's `e2e` job.
//
// Backend: the CI stack (server/docker-compose.ci.yml), reached through its caddy on ONE origin —
// the production topology. Not the services' direct host ports: the client derives several bases
// from the API base by path (analytics is the API base minus `/api`, client/src/analytics/index.ts),
// and only the real Caddyfile routes those paths; pointed straight at metaserver, the analytics
// config fetch hits metaserver's 501 stub and every no-console-error assertion fails on it.
// NW_E2E_PROXY_PORT is the same variable the compose overlay publishes caddy on (CI: unset → 18088;
// scripts/e2e-local.sh: 28088). Locally: `bash scripts/e2e-local.sh` runs this against that stack.
const PROXY_PORT = process.env.NW_E2E_PROXY_PORT || '18088';
const STACK = `http://localhost:${PROXY_PORT}`;

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.ts',
  // The specs pinned to the local Docker stack (:8088, seeded through `docker exec` into its Mongo,
  // ~30-minute walks) belong to playwright.portrait.config.ts, which owns that list — they cannot
  // run against the CI stack and are not part of this gate.
  testIgnore: LOCAL_STACK_SPECS,
  timeout: 60_000,
  fullyParallel: false,
  // CI: pinned to what a GitHub ubuntu-latest runner (4 vCPU) gets by default anyway — Playwright
  // uses half the cores. Pinned rather than left to the default so scripts/e2e-local.sh (CI=true)
  // replays the runner instead of the dev machine: on a 22-core box the default is 11, and six
  // specs cold-loading the dev bundle at once (~265 requests each, every page rendering through
  // software WebGL) starved the dev server — `page.goto('/')` took 61 s and the first wave timed
  // out, then passed on retry (2026-10-08). Local non-CI runs keep the default.
  workers: process.env.CI ? 2 : undefined,
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
    // --no-open: `devServer.open: true` (webpack.config.js) would pop the machine's default
    // browser on every run; the spec drives its own Playwright browser.
    //
    // CI serves a PRODUCTION build of the same web-e2e entry (minified, no source maps) — the
    // shape players actually load. The development bundle is several times larger, and every spec
    // cold-loads it in a fresh page on the runner's software WebGL: on CI each spec took 17–32 s
    // against 2–7 s on a dev machine, and the two-account spec (two such pages) timed out once and
    // passed on retry. Local non-CI runs keep the development server, for its rebuild speed while
    // iterating on a spec. The production compile is slower to start, hence the longer timeout.
    // `start:e2e:prod` passes --no-client-overlay-warnings: production mode emits webpack's
    // asset-size warnings, and the dev server's overlay iframe would cover the canvas — the
    // audio specs' first tap then lands on the overlay, audio never unlocks, and they time out
    // (first try of this switch, 2026-10-08). Compile ERRORS still get the overlay.
    command: process.env.CI ? 'npm run start:e2e:prod -- --no-open' : 'npm run start:e2e -- --no-open',
    url: 'http://localhost:9096',
    // Every base on the one origin, as a production web build resolves them (Caddyfile paths).
    env: {
      NW_API_BASE:     `${STACK}/api`,
      NW_GATEWAY_WS:   `ws://localhost:${PROXY_PORT}/gw`,
      NW_WORLD_BASE:   STACK,
      NW_SOCIAL_BASE:  STACK,
      NW_AUCTION_BASE: STACK,
    },
    reuseExistingServer: !process.env.CI,
    timeout: process.env.CI ? 180_000 : 60_000,
  },
});
