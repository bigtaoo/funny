import path from 'path';
import type { Plugin } from 'vitest/config';

/**
 * stubBinaryAssets — resolve `import url from './foo.tao'` (and, optionally, images/audio) to a
 * URL string, the way webpack's `asset/resource` does in a real build.
 *
 * Vite/vitest already handles the extensions it knows (`.png`, `.mp3`, ...) natively, giving each
 * file its own URL — several coverage-suite tests depend on that uniqueness (e.g.
 * `test/render/towerArtContract.test.ts` asserts the tower art is not the barracks art by comparing
 * two imported URLs). What vite cannot do is parse an extension it has never heard of: a `.tao`
 * import (our skeletal-rig bundle format) is handed to the JS parser and the importing module dies
 * at load. That is the one thing the coverage suite needs fixed, which is why `TAO_ONLY` is the
 * default.
 *
 * `as` is the other half, and it is not cosmetic — it decides whether URL identity means anything:
 *   - `'path'` (default) mirrors webpack: one distinct URL per file, resolved through the importer
 *     so the same file imported from two directories gets the SAME url. Assertions like "the skin
 *     rig is not the default rig" can then actually fail.
 *   - `'data-uri'` maps every stubbed import to ONE 1×1 transparent PNG, which is what
 *     `vitest.ui.config.ts` needs: those suites build real PIXI display objects, so an image URL
 *     must be something `Texture.from()` accepts with no file system and no `document` (its
 *     crossOrigin path early-returns for `data:` URLs). The cost is that every asset URL in that
 *     suite is equal, so a test there must treat them as opaque — several of its files say so in
 *     as many words. `.tao` URLs are never loadable under either mode; `StickmanRuntime.loadAsset`
 *     fetches them fire-and-forget and swallows the (harmless) failure.
 *
 * Lives in test/harness/ rather than inline in a config because both configs need it now: test/ui
 * needed it first, but "can this module be imported at all" is not a UI concern, and a second copy
 * is a second thing to drift (the deleted `vitest.render.config.ts` is the cautionary tale — see
 * vitest.config.ts's header).
 */

/** Everything webpack routes through `asset/resource`. Only test/ui needs the images stubbed. */
export const ALL_BINARY_ASSETS = /\.(png|tao|jpg|jpeg|webp|gif|mp3|wav|ogg)$/;
/** Just the extension vite has no loader for, i.e. the one that breaks module loading outright. */
export const TAO_ONLY = /\.tao$/;

export interface StubBinaryAssetsOptions {
  /** Which import specifiers to stub. Default {@link TAO_ONLY}. */
  match?: RegExp;
  /** What a stubbed import resolves to: a per-file URL (default) or one shared 1×1 PNG data URI. */
  as?: 'path' | 'data-uri';
}

/** A 1×1 transparent PNG. */
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk' +
  'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function stubBinaryAssets(opts: StubBinaryAssetsOptions = {}): Plugin {
  const match = opts.match ?? TAO_ONLY;
  const as = opts.as ?? 'path';
  const PREFIX = '\0stub-asset:';
  return {
    name: 'stub-binary-assets',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!match.test(id)) return null;
      // Resolved against the importer, so `./units/infantry.tao` from assets/bootManifest.ts and
      // `../../assets/units/infantry.tao` from render/UnitView/assets.ts are ONE stub id — without
      // this, `as: 'path'` would hand the same physical rig two different URLs.
      const resolved = id.startsWith('.') && importer
        ? path.resolve(path.dirname(importer), id)
        : id;
      return PREFIX + resolved;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const file = id.slice(PREFIX.length);
      // The absolute path, posix-ised — deliberately NOT a prettier `/units/infantry.tao`: the
      // whole point of `as: 'path'` is that two different files can never produce the same string,
      // and any shortening scheme reintroduces the chance of a collision making an assertion
      // vacuous. This is also roughly what vite hands back for a `.png` it resolves itself.
      const url = as === 'data-uri' ? PNG_1x1 : `/${file.replace(/\\/g, '/').replace(/^\/+/, '')}`;
      return `export default ${JSON.stringify(url)};`;
    },
  };
}
