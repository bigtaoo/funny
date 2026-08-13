import { defineConfig } from 'vitest/config';

// Tests cover the io/ layer only (see io/{fileIO,clipSerialization,editorProject,taoExport}.ts
// split, claudedocs/animator.md): pure serialization + disk/File-System-Access-API plumbing.
// `ImageController` (images/ImageController.ts) is the one dependency that reaches into real
// `pixi.js` texture creation — the editor has no headless PIXI harness like
// client/test/harness/pixiHeadless.ts, so tests that need an image-controller-shaped object use
// a hand-rolled fake (getBlob/setBlob only, matching what editorProject.ts/taoExport.ts actually
// read) instead of the real class. `AppState`/`AnimationController`/`CommandManager`/`EventBus`
// have zero PIXI/DOM dependency and are used as real instances.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
