import path from 'path';
import { defineConfig, coverageConfigDefaults } from 'vitest/config';

// Mostly the pure game-logic core (@nw/engine + src/game/**), which has no PIXI dependency —
// but not exclusively: `test/render/**` matches the include below too, and those files do import
// pixi.js-legacy (faked per-file via vi.mock in most of them, real in icons/rewardIcon.test.ts).
// They used to also have a vitest.render.config.ts of their own; deleted 2026-08-15. Nothing ever
// ran it — no CI step, no script chain — so its alias list silently drifted behind this one's and
// 4 of the 11 files died at load there, while this config had been running all 11 green the whole
// time. Deleting it removes the second place for that alias list to rot; there is now one suite.
export default defineConfig({
  // @nw/engine resolves to its TS source (server/engine/src) — the engine moved
  // out of client into the workspace package (§16.7) and is imported directly;
  // the old src/game/* re-export shims were deleted (2026-08-02).
  // @nw/shared mirrors the webpack/tsconfig alias to the browser-safe SLG slice
  // (server/shared/src/slg/index.ts), NOT the node-only barrel.
  resolve: {
    alias: {
      '@nw/engine': path.resolve(__dirname, '../server/engine/src'),
      '@nw/shared/cards': path.resolve(__dirname, '../server/shared/src/cards.ts'),
      '@nw/shared': path.resolve(__dirname, '../server/shared/src/slg/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // The whole-battle simulation suites live in vitest.sim.config.ts instead (`npm run test:sim`,
    // and both `test` and `test:coverage` chain it after this config, so nothing stops running).
    // Why they are split out (2026-08-15): they are ~93% of this suite's wall clock (188s total, of
    // which ~175s is these files — ch6 alone 331s under coverage) and they pay the v8 instrumentation
    // tax on every tick of a many-thousand-tick engine loop, which is what made the full coverage run
    // cost 668s and forced the old "no coverage on PRs" split that let a coverage regression reach
    // main unnoticed. Measured: excluding them changes client line coverage by 0.05pp
    // (91.20% → 91.15%) — everything they touch in src/game/** is already covered by the unit
    // suites — while dropping the coverage run from 668s to ~13s. So CI can now afford coverage on
    // EVERY event (see .github/workflows/ci.yml) instead of only before CD.
    exclude: ['test/difficulty/**', 'test/pvpSim.test.ts', '**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Deliberately NARROWER than the test `include` above. `test/render/**` does run in this
      // suite and does touch src/render/**, but only as a handful of narrow regression guards that
      // mock most of PIXI away — the coverage they would report over the render layer is sparse
      // and misleading. Systematic render/UI/scene coverage is test:ui/test:e2e's job (neither
      // reports coverage). Scoping to src/game/** keeps the % honest instead of drowning it in
      // near-0% render-layer files this suite only brushes against.
      include: ['src/game/**'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
