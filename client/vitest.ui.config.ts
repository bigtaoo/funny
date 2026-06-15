import { defineConfig } from 'vitest/config';

// UI smoke tests — construct real PIXI scenes headlessly and assert they build,
// update and tear down without throwing. NO live server, NO renderer, NO browser:
// the setup file (pixiHeadless) swaps PIXI's DOM adapter for a pure-JS stub, so this
// runs in plain Node and is safe for CI without Docker.
//
// This is a STARTUP/regression smoke layer, not a visual-regression layer — it
// catches "a scene constructor now throws / reads an undefined layout rect" class
// breakage. Pixel-level checks are deferred until the UI stabilises (post-launch).
//
// Named *.ui.ts (not *.test.ts) so the default `npm test` never picks it up; runs
// via `npm run test:ui`.
export default defineConfig({
  test: {
    include: ['test/ui/**/*.ui.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['./test/harness/pixiHeadless.ts'],
  },
});
