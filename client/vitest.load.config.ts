import { defineConfig } from 'vitest/config';

// Load / capacity test — spins up N concurrent headless clients (real createAppCore)
// against a LIVE server stack and measures how many get through registration →
// gateway connect → ranked matchmaking within a deadline, reporting pairing latency.
//
// Opt-in only (`npm run test:load`) — needs the full stack running (meta + gateway +
// matchsvc + game + commercial + mongo), same prereq as the E2E. Tune the fleet size
// with NW_LOAD_CLIENTS (default 100); raise it later to probe a single server's
// real ceiling.
//
// Named *.load.ts so neither `npm test` nor `npm run test:e2e` picks it up.
export default defineConfig({
  test: {
    include: ['test/load/**/*.load.ts'],
    environment: 'node',
    globals: false,
    // A fleet of 100+ clients takes a while to register + pair; give it room.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // One process: all clients share the matchmaking queue; serial keeps it clean.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
