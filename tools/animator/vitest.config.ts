import { defineConfig } from 'vitest/config';

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
  },
});
