import path from 'path';
import { defineConfig } from 'vitest/config';
import { stubBinaryAssets, ALL_BINARY_ASSETS } from './test/harness/stubBinaryAssets';

// The binary-asset stub (`import url from './foo.png'` -> a dummy URL string, webpack's
// asset/resource in a real build) used to live inline here. It moved to test/harness/ on
// 2026-09-09 when vitest.config.ts needed it too — the gameplay scenes this suite constructs are
// not the only things that reach a raw asset import; `assets/bootManifest.ts` does it directly,
// and that is a PIXI-free module that belongs in the coverage suite. This suite keeps the WIDE
// extension set AND the single-data-URI form: it builds real PIXI display objects, so a texture URL
// has to be something `Texture.from()` accepts in Node — at the cost of every asset URL here being
// equal, which a dozen files in test/ui already note in their headers. The coverage suite takes the
// narrow, per-file default; see the plugin's header for why the two differ.

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
  plugins: [stubBinaryAssets({ match: ALL_BINARY_ASSETS, as: 'data-uri' })],
  resolve: {
    alias: {
      '@nw/engine': path.resolve(__dirname, '../server/engine/src'),
      '@nw/shared/cards': path.resolve(__dirname, '../server/shared/src/cards.ts'),
      '@nw/shared/equipment': path.resolve(__dirname, '../server/shared/src/equipment.ts'),
      '@nw/shared/battlepass': path.resolve(__dirname, '../server/shared/src/battlepass.ts'),
      '@nw/shared/rechargeMilestone': path.resolve(__dirname, '../server/shared/src/rechargeMilestone.ts'),
      '@nw/shared/titles': path.resolve(__dirname, '../server/shared/src/titles.ts'),
      // Browser-safe slice, same as webpack.config.js/vitest.config.ts — NOT the full
      // src/index.ts barrel, which re-exports jwt.ts (-> 'jsonwebtoken', a server-only
      // dep this client-side test run never installs). Every current bare '@nw/shared'
      // import in client/src + test/ui resolves to something under slg/*, so this covers
      // them all; a future import of a non-slg, non-cards export needs its own deep
      // alias here (see '@nw/shared/cards' above) rather than widening this one.
      '@nw/shared': path.resolve(__dirname, '../server/shared/src/slg/index.ts'),
    },
  },
  test: {
    include: ['test/ui/**/*.ui.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['./test/harness/pixiHeadless.ts'],
  },
});
