import { defineConfig, coverageConfigDefaults } from 'vitest/config';

// Phase 1-2 covered the io/ layer (see io/{fileIO,clipSerialization,editorProject,taoExport}.ts
// split, claudedocs/animator.md): pure serialization + disk/File-System-Access-API plumbing, plus
// core/{EventBus,CommandManager}.ts. `ImageController` (images/ImageController.ts) is the one
// dependency that reaches into real `pixi.js` texture creation — the editor has no headless PIXI
// harness like client/test/harness/pixiHeadless.ts, so tests that need an image-controller-shaped
// object use a hand-rolled fake (getBlob/setBlob only, matching what editorProject.ts/taoExport.ts
// actually read) instead of the real class. `AppState`/`AnimationController`/`CommandManager`/
// `EventBus` have zero PIXI/DOM dependency and are used as real instances.
//
// Phase 4 (2026-08-13, tools-test-coverage-plan memory) extracted+exported two more pure
// functions that had zero actual dependency on `this`/canvas/window despite living inside
// PIXI/DOM-heavy files: interaction/InteractionController.ts's `pointToSegmentDist` +
// `findBoneAt` (tested against REAL Skeleton.computeFK rest-pose geometry, not hand-rolled
// coordinates) and timeline/TimelineView.ts's `getKfColors`. The Renderer/InteractionController/
// TimelineView CLASSES themselves (construction, `new PIXI.Application`, canvas/window listener
// wiring) remain out of scope — still no headless-PIXI harness for this tool.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // ADR-070 (2026-08-20): `include` is the machine-readable form of the scope this header has
      // described in prose since Phase 1 — the layers with no PIXI/DOM dependency. Same shape as
      // client/vitest.config.ts, which scopes to src/game/** and leaves its render layer out for
      // exactly this reason (coverage over a layer the suite only brushes against is sparse and
      // misleading, and systematic render testing is a different tool's job).
      //
      // This list was NOT drawn to flatter the number: it deliberately kept the whole untested
      // IndexedDB layer inside the scope, which is why it printed 64.3% (927/1442) when ADR-070
      // landed. That gap was the work, not something to define away, and Phase 4d (2026-08-20,
      // same day) closed it: **98.9% (1426/1442 lines)**, with io/{AutoSaveController,ProjectStore,
      // IOController}.ts going 0% -> 100% and animation/AnimationController.ts 41.3% -> 100%.
      // The package is now GATED on the 90% line bar (scripts/coverageLib.mjs's
      // JSON_SUMMARY_PACKAGES). ProjectStore drives a real (in-memory) IndexedDB via
      // `fake-indexeddb`, following vfx-editor's precedent; AutoSaveController cannot, because it
      // needs `vi.useFakeTimers()` for its 1500ms debounce and fake timers deadlock
      // fake-indexeddb — see the header of test/AutoSaveController.test.ts.
      //
      // The 16 lines still uncovered are taoExport.ts's texture-bake path, which needs a real
      // canvas 2d context (`drawImage` into `document.createElement('canvas')`) — the one place in
      // this scope that a headless-canvas harness would be required.
      //
      // Passing the gate is NOT the same as the boundary being guarded: at this coverage the gate
      // has ~140 lines of headroom (`covered/0.9 - total`), so a mid-sized 0%-covered PIXI file
      // dropped into any of the four directories would keep it green — measured, with a 143-line
      // probe. test/pureLayerBoundary.test.ts is what actually holds the line; see its header.
      //
      // Out of scope, unchanged from the prose above: rendering/Renderer.ts, ui/*, images/*,
      // index.ts + App.ts (DOM/PIXI construction glue, no headless harness for this tool), and
      // interaction/InteractionController.ts + timeline/TimelineView.ts — those two DO hold pure
      // exported seams (pointToSegmentDist/findBoneAt/getKfColors, tested via test/{Interaction
      // Controller,TimelineView}.test.ts) but they are still embedded in otherwise PIXI-heavy
      // files, so a directory include cannot isolate them. Extracting them into their own modules
      // would let them join the scope; it is not scheduled, and ADR-070's Phase 4d turned out to be
      // the IndexedDB/AnimationController test gap above rather than that extraction.
      include: ['src/core/**', 'src/skeleton/**', 'src/animation/**', 'src/io/**'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
