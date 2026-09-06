import { defineConfig } from 'vitest/config';

// SLG order-throughput load test — the capacity probe for worldsvc's march dispatch path.
//
// Drives NW_LOAD_BOTS (default 200) real REST clients against a LIVE stack and measures what the
// worldsvc-concurrency-2026-09-05 audit set out to fix: how many march orders per second the service
// digests, at what dispatch latency, and — read back from worldsvc's own `/admin/world/metrics` — whether
// its event loop ever stalled while doing it.
//
// Opt-in only (`npm run test:load -w @nw/worldsvc`). Needs the docker stack up; see the test file header
// for the exact commands and knobs.
//
// Deliberately NOT the default config: no globalSetup (this talks to a real cluster, not an in-memory
// Mongo), no retry (a retried capacity probe reports the luckier of two runs, which is worse than a
// number you can trust), and a long timeout because a 200-bot ramp plus a load window takes minutes.
//
// Named *.load.ts so the normal `include: ['test/**/*.test.ts']` can never pick it up: an accidental CI
// run would hammer whatever stack the runner could reach, and fail for the wrong reasons on a cold one.
export default defineConfig({
  test: {
    include: ['test/load/**/*.load.ts'],
    environment: 'node',
    globals: false,
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
