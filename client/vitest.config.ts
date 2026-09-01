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
        // audio (2026-08-31, AUDIO_DESIGN.md): a DIRECTORY entry from day one rather than the
        // per-file shape most of this list still has — `src/audio/**` is the platform-neutral half
        // of the audio layer by construction (the backend lives in `src/platform/web/`), so a file
        // landing here later is a pure module too and should be gated without a second edit here.
        // It arrives already covered: test/audio/** is 79 cases over every module in it.
        'src/audio/**',
        // ...and the two music DECKS, which live under `platform/` but are not the 15-line
        // pass-throughs the SFX platform halves are (2026-09-01, §7 step 7). §0.3 already recorded
        // what a partial include costs: "`src/audio/**` is 100%" stayed true the entire time
        // `WebAudioBus` had zero cases, because a percentage only means anything inside the
        // include. Each deck carries a branch that fails SILENTLY — `crossOrigin` (unset = a
        // CDN-hosted bed feeds silence into the WebAudio graph, with no error anywhere) and the
        // `Number.isFinite` guard on WeChat (`NaN >= seam` is false forever, i.e. a loop that
        // never wraps again) — so they are gated where they live.
        'src/platform/web/webMusicDeck.ts',
        'src/platform/wechat/wechatMusicDeck.ts',
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
        // the outbound REST seam (2026-09-01, ASSET_PACKAGING §4.5) — every REST call in the client
        // goes through it, and its WeChat half is unreachable from any suite that has a global fetch
        'src/net/transport.ts',
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
        // ui: the PIXI-free half. `ui/hits.ts` (2026-08-31, AUDIO_DESIGN.md §7 step 4) is the
        // client's single hit table + dispatcher — pure geometry plus the one place a UI cue is
        // emitted, no PIXI import, and what 40 scenes' tap handling now runs through, so a
        // regression here is a regression everywhere at once. Gated from the day it landed.
        'src/ui/hits.ts',
        // scenes: the already-extracted pure modules — exactly the shape ADR-070's client half will
        // produce more of, one scene at a time (4b)
        'src/scenes/EquipmentScene/helpers.ts',
        'src/scenes/EquipmentScene/layout.ts',
        'src/scenes/LobbyScene/format.ts',
        'src/scenes/realLayerInterludeArt.ts',
        // 4b, first scene group (2026-08-27): worldmap's pure layer is now a DIRECTORY, which is the
        // shape ADR-070 asked for — five per-file entries collapsed into one entry that also picks up
        // whatever lands there next. `test/pureLayerBoundary.test.ts` is what keeps it a pure layer;
        // this percentage does not (see that file's header for why the 90% bar cannot guard a boundary).
        'src/scenes/worldmap/logic/**',
        // 4b, second scene group (2026-08-27): CardScene. Three PIXI-free modules — cardSort,
        // feedPlan, types — collapse the single `CardScene/feedPlan.ts` entry above into a directory.
        // The two files that did NOT move, on purpose: `input.ts` is the pointer plumbing and
        // `header.ts` the title bar; both are Core collaborators that read and write `core.*` (and
        // header.ts draws), i.e. the same call ADR-071 4b made for WorldMapRenderer/viewport.ts.
        // Neither is gated per-file either — unlike viewport.ts they have no fake-ctx suite to gate.
        'src/scenes/CardScene/logic/**',
        // 4b, groups THREE and FOUR (2026-08-27): FriendsScene/FamilyScene/SectScene and ui/dialogs
        // get NO logic/ directory, and that is the finding rather than a shortcut. Measured with the
        // pureLayerBoundary algorithm over every file in all four: `ui/dialogs` has ZERO PIXI-free
        // modules (all 7 import pixi.js-legacy directly and call txt/sketchPanel — it is drawing code
        // wall to wall), and in the three social scenes the only PIXI-free files are two type-only
        // `types.ts` (below this list's ~10-executable-line floor) plus the pointer/input modules,
        // which are Core collaborators, not pure logic. 4b's priority list was built from lines x bug
        // frequency, which says nothing about whether a pure layer EXISTS to extract; worldmap and
        // CardScene had one because earlier 500-line splits had already produced it, and these two
        // groups' splits went along a different axis. See ADR-071's 4b progress entry.
        //
        // What the survey did find worth fixing: these two carry the tap-vs-drag routing, the modal
        // interception order and the per-column scroll clamp for two whole scenes — 140 and 136 lines,
        // three documented past bugs between them — with no direct test of ANY kind (test/ui's
        // socialScrollTranslate.ui.ts drives FriendsScene, a different file). Gated per-file with a
        // fake-core suite, exactly the treatment WorldMapRenderer/viewport.ts got, and for the same
        // reason: testable arithmetic on a collaborator, so gate it where it lives instead of moving it
        // somewhere that would make the boundary guard a lie.
        'src/scenes/FamilyScene/pointer.ts',
        'src/scenes/SectScene/pointer.ts',
        // ...and FriendsScene's equivalent, added when the third scene of that group got its own
        // suite (test/friendsSceneInputRouting.test.ts). NOT the same code as the other two: own drag
        // tracking instead of ScrollTapGesture, a 2D hypot threshold of 8 rather than the gesture's 6,
        // modal taps firing on up with no drag-cancel, and both scroll clamps in the file. Unlike them
        // it does import PIXI transitively (via ./core, for clamp/DRAG_THRESHOLD), which is why it is
        // gated per-file here and not a candidate for any logic/ directory.
        'src/scenes/FriendsScene/input.ts',
        // ...and one file that did NOT move, on purpose: WorldMapRendererViewport is a renderer
        // collaborator, not pure logic — it mutates `core.ctx` and calls into pool/panels/net. Its
        // arithmetic happens to be testable with a fake ctx (95.8% before this pass), which is why it is
        // gated at all, but moving it into `logic/` would make the boundary guard a lie.
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
