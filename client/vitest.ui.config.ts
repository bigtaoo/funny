import path from 'path';
import { defineConfig, type Plugin } from 'vitest/config';

// Webpack resolves `import url from '../assets/foo.png'` (and .tao) to a URL string
// via asset/resource. Vitest has no such loader, so the gameplay scenes (which pull
// in the full render layer: BoardView / HandView / UnitView .png + .tao imports)
// fail to parse. Stub every binary asset import to a dummy URL string — the headless
// smoke never loads real pixels (StickmanRuntime.loadAsset fetches fire-and-forget
// and swallows the failure; bake.ts has no renderer so it draws live).
function stubBinaryAssets(): Plugin {
  const RE = /\.(png|tao|jpg|jpeg|webp|gif|mp3|wav|ogg)$/;
  const PREFIX = '\0stub-asset:';
  return {
    name: 'stub-binary-assets',
    enforce: 'pre',
    resolveId(id) {
      return RE.test(id) ? PREFIX + id : null;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      // A 1×1 transparent PNG data URI: PIXI.Texture.from() picks ImageResource and
      // its crossOrigin path early-returns for `data:` URLs (no `document` needed);
      // the stubbed global Image (pixiHeadless.ts) holds it without decoding pixels.
      // .tao imports get the same value — StickmanRuntime.loadAsset fetches it
      // fire-and-forget and swallows the (harmless) parse failure.
      const PNG_1x1 =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk' +
        'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      return `export default ${JSON.stringify(PNG_1x1)};`;
    },
  };
}

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
  plugins: [stubBinaryAssets()],
  resolve: {
    alias: {
      '@nw/engine': path.resolve(__dirname, '../server/engine/src'),
      '@nw/shared': path.resolve(__dirname, '../server/shared/src/index.ts'),
    },
  },
  test: {
    include: ['test/ui/**/*.ui.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['./test/harness/pixiHeadless.ts'],
  },
});
