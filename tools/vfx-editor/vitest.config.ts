import { defineConfig } from 'vitest/config';

// Bootstrap only (see claudedocs/animator.md's 2026-08-13 note on scope) — covers the editor's
// PURE colour-helper layer (model/color.ts). Anything that touches PIXI (rendering/*, ui/*) or
// the DOM (io/*, index.ts) is out of scope: those build a real PIXI.Application / call
// getElementById at import time, and this editor has no headless harness like
// client/test/harness/pixiHeadless.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
