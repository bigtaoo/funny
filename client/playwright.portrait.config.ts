import { defineConfig, devices } from '@playwright/test';

// Portrait layout sweep config (test/browser/portraitLayout.spec.ts). Separate from
// playwright.config.ts for one reason: the backend. The smoke config expects the bare-metal dev
// stack (metaserver 18080 / gateway 8086, `npm run dev:all`); this one is pinned to the Docker
// stack, where nginx fronts everything on ONE origin (docker/docker-compose.local.yml). Baking
// those URLs in here — rather than asking whoever runs it to remember five NW_* variables — is
// what makes `npm run test:portrait` reproducible; a wrong base does not fail loudly, it just
// fails to register and the whole sweep times out on the login screen.
//
// Its own dev-server port (9097) so it can run beside the smoke config's 9096 without either
// stealing the other's differently-configured bundle.
//
// Prereq: `./docker/local-up.ps1` from the repo root. Run: npm run test:portrait
const STACK = 'http://localhost:8088';

export default defineConfig({
  testDir: './test/browser',
  testMatch: 'portraitLayout.spec.ts',
  // Six viewports x ~33 stops, each a real navigation (or a real tap into a modal) against a real
  // backend, and one Playwright test per viewport — so this is the budget for ONE viewport's whole
  // walk, not for the run. The run is ~25 minutes.
  timeout: 600_000,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://localhost:9097',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // --no-open: webpack.config.js sets `devServer.open: true` for hand-run dev sessions, which
    // pops the machine's DEFAULT browser every time the harness boots a server. A test run must
    // not take over the desktop.
    command: 'npm run start:e2e -- --port 9097 --no-open',
    url: 'http://localhost:9097',
    env: {
      NW_API_BASE:     `${STACK}/api`,
      NW_GATEWAY_WS:   'ws://localhost:8088/gw',
      NW_WORLD_BASE:   STACK,
      NW_SOCIAL_BASE:  STACK,
      NW_AUCTION_BASE: STACK,
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
