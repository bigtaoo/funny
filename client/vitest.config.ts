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
      // reports coverage). Scoping to src/game/** kept the % honest instead of drowning it in
      // near-0% render-layer files this suite only brushes against.
      //
      // 2026-08-21: src/game/** ALONE was 1924 of src/'s 55143 executable lines — 3.5% of the
      // client under the 90% gate. Measured with the include temporarily widened to src/**, this
      // suite's 409 test files cover 30.6% of the whole tree, but that number is two populations
      // stacked: the scene/render layer is 0–15% (scenes/worldmap 1.9%, CityScene 0%, ui/dialogs
      // 2.7% ...), while dozens of individual modules OUTSIDE src/game/** were already at 90–100%
      // and gated by nothing — they could rot to 50% and no CI step would notice. Every entry below
      // is one of those: already-covered ground, moved inside the gate at zero new test cost. The
      // client number goes 91.2% (1924 lines) -> 94.8% (4260 lines), i.e. the scope more than
      // doubles and the percentage goes UP, which is the opposite of the direction a scope change
      // is normally suspicious in (see scripts/coverageLib.mjs's `Scope (files)` column).
      //
      // Yes, these are per-file entries, and ADR-070 calls a per-file include "the smell of a
      // missing module boundary". That still holds — it is why this list is explicitly TRANSITIONAL.
      // The objection there was about per-file entries NARROWING a scope (hiding untested siblings
      // inside a flattering number); here they only ADD gated ground, and the list doubles as the
      // machine-readable to-do list for the client half of ADR-070: each time a scene's or layer's
      // pure logic is extracted into its own directory, that directory replaces its file entries
      // here. `test/coverageScope.test.ts` fails if any entry stops matching a real file, so the
      // list can go stale but not silently.
      //
      // Floor of ~10 executable lines per entry: barrels and 1-line re-export shims (net/anomaly.ts,
      // app/nav/shop.ts, render/atlas/emblemAtlas.ts, platform/stubs/**, ...) are 100% covered but
      // gate nothing, and would just make this list longer.
      include: [
        'src/game/**',
        // analytics / app wiring
        'src/analytics/queue.ts',
        'src/app/appConstants.ts',
        'src/app/matchEngine.ts',
        'src/app/nav/room.ts',
        // assets / cache / i18n / layout
        'src/assets/assetIO.ts',
        'src/cache/MemoryMonitor.ts',
        'src/cache/ObjectPool.ts',
        'src/cache/poolRegistry.ts',
        'src/i18n/index.ts',
        'src/layout/LandscapeLayout.ts',
        'src/render/bake.ts',
        'src/layout/PortraitLayout.ts',
        // net: the transport bits with real suites (the two big *ApiClient facades are ~50% and
        // stay out — they are one-line forwards whose coverage says nothing either way)
        'src/net/ApiClient/core.ts',
        'src/net/ApiClient/equipment.ts',
        'src/net/WorldApiClient/core.ts',
        'src/net/anomaly/reporter.ts',
        'src/net/judgeRunner.ts',
        'src/net/rateGate.ts',
        'src/net/replayCompress.ts',
        'src/net/replayUpload.ts',
        'src/net/serverClock.ts',
        // platform
        'src/platform/localReminders.ts',
        'src/platform/uuid.ts',
        // render: only the PIXI-free helpers (geometry, theming, art descriptors, vfx defs) —
        // everything that actually draws stays out, per the paragraph at the top of this block
        'src/render/HUDView/hpBar.ts',
        'src/render/TutorialDirector/panels.ts',
        'src/render/atlas/spriteAtlas.ts',
        'src/render/fontScale.ts',
        'src/render/heroAvatarArt.ts',
        'src/render/portraitHeadBox.ts',
        'src/render/presetAvatarArt.ts',
        'src/render/rewardIcon.ts',
        'src/render/skinAvatarArt.ts',
        'src/render/stickman/constants.ts',
        'src/render/theme.ts',
        'src/render/vfx/parseEffectDef.ts',
        'src/render/vfx/registry.ts',
        'src/render/vfx/sampleParam.ts',
        // scenes: the already-extracted pure modules — exactly the shape ADR-070's client half will
        // produce more of, one scene at a time (4b)
        'src/scenes/CardScene/feedPlan.ts',
        'src/scenes/EquipmentScene/helpers.ts',
        'src/scenes/EquipmentScene/layout.ts',
        'src/scenes/LobbyScene/format.ts',
        'src/scenes/realLayerInterludeArt.ts',
        'src/scenes/worldmap/WorldMapRenderer/viewport.ts',
        // ui
        'src/ui/busyTracker.ts',
        'src/ui/scrollTapGesture.ts',
        'src/ui/widgets/hudButton.ts',
        'src/ui/widgets/scrollPeek.ts',
      ],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
