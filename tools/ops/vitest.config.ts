import { defineConfig } from 'vitest/config';

// Bootstrap only (see claudedocs/animator.md's 2026-08-13 note on scope) — covers the ops
// admin console's PURE ms<->datetime-local helpers (pages/shared.ts). Everything else in this
// package is plain-DOM page renderers built directly against `document`/`window` at call time
// (not just import time, unlike map-editor's dom.ts), but still assumes a real browser fetch/
// localStorage session — out of scope for this bootstrap pass.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
