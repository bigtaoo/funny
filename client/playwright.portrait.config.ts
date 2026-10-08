import { defineConfig, devices } from '@playwright/test';

// Portrait layout sweep config (test/browser/portraitLayout.spec.ts). Separate from
// playwright.config.ts for one reason: the backend. The smoke config is the CI gate and runs against
// the CI stack (server/docker-compose.ci.yml behind its caddy); this one is pinned to the local
// Docker stack, where nginx fronts everything on ONE origin (docker/docker-compose.local.yml) and
// whose Mongo the sweep seeds through `docker exec nw-local-mongo` (test/browser/lib/seed.ts). Baking
// those URLs in here — rather than asking whoever runs it to remember five NW_* variables — is
// what makes `npm run test:portrait` reproducible; a wrong base does not fail loudly, it just
// fails to register and the whole sweep times out on the login screen.
//
// Its own dev-server port (9097) so it can run beside the smoke config's 9096 without either
// stealing the other's differently-configured bundle.
//
// Prereq: `./docker/local-up.ps1` from the repo root. Run: npm run test:portrait
const STACK = 'http://localhost:8088';

/**
 * Every spec that needs THIS stack — and therefore not the CI one. Exported because
 * playwright.config.ts (the CI browser smoke gate) ignores exactly this list: one list, so a spec
 * cannot end up in both configs or in neither.
 *
 * The sweep, the rotation sweep (2026-09-14 — same stack, same walk, one viewport turned sideways
 * mid-stop), plus three opt-in harnesses that need the same stack: captureEndStats.spec.ts skips
 * itself unless NW_CAPTURE=1, bakeBudget.spec.ts unless NW_BAKE=1, frameCost.spec.ts unless
 * NW_FRAMECOST=1 — so listing them here costs three skipped tests and buys the ability to
 * regenerate the end-stats fixture, re-measure the bake ceiling and re-run the frame-cost bench
 * against the same stack, on the same dev server, with one command. (frameCost moved here from the
 * smoke config on 2026-10-08: it always needed this stack — its own header says the dev server must
 * be built against :8088 — and in the smoke config it was a permanent skip inside the CI gate.)
 */
export const LOCAL_STACK_SPECS = /(portraitLayout|rotateLayout|captureEndStats|bakeBudget|frameCost)\.spec\.ts$/;

export default defineConfig({
  testDir: './test/browser',
  testMatch: LOCAL_STACK_SPECS,
  // Twelve viewports x 48 stops, each a real navigation (or a real tap into a modal) against a real
  // backend, and one Playwright test per viewport — so this is the budget for ONE viewport's whole
  // walk, not for the run. The run is ~30 minutes.
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
