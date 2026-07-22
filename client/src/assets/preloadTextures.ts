/**
 * preloadTextures.ts — shared L0/L1 texture preload helper (ASSET_PACKAGING §4.1).
 *
 * Wraps `assetIO().textureSource(url)` → `PIXI.BaseTexture.from(src)` and registers
 * the result under the ORIGINAL url as an alias when src ≠ url (WeChat local-file
 * case). Without the alias, `PIXI.Texture.from(url)` misses the cache and re-fetches
 * from CDN every session. Web is unaffected (src === url, alias is a no-op).
 *
 * Every caller here is a standalone illustration (unit/hero/building/spell art, logo)
 * that gets drawn far smaller than its native size — hero portraits shrink ~6× in the
 * roster grid. So we opt these base textures into {@link ART_TEX_OPTIONS}: mipmaps ON,
 * which enables trilinear minification and kills the sparkle/white-speckle aliasing that
 * plain LINEAR downscaling produces on detailed NPOT art (esp. Anna's max/lena/mara).
 * PIXI only actually generates NPOT mipmaps on WebGL2 (see TextureSystem: POW2/WebGL1
 * NPOT falls back to no mipmap), so this is a safe no-op on the WeChat WebGL1 path.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from './assetIO';

/** Base-texture options for downscaled standalone art — mipmaps for clean minification. */
export const ART_TEX_OPTIONS: Partial<PIXI.IBaseTextureOptions> = {
  mipmap: PIXI.MIPMAP_MODES.ON,
  scaleMode: PIXI.SCALE_MODES.LINEAR,
};

export function preloadTexture(url: string): Promise<void> {
  return assetIO().textureSource(url).then((src) => new Promise<void>((resolve) => {
    const baseTex = PIXI.BaseTexture.from(src, ART_TEX_OPTIONS);
    if (src !== url) {
      PIXI.BaseTexture.addToCache(baseTex, url);
      PIXI.Texture.addToCache(new PIXI.Texture(baseTex), url);
    }
    if (baseTex.valid) { resolve(); return; }
    baseTex.once('loaded', () => resolve());
    baseTex.once('error', () => resolve());
  }));
}

export function preloadTextureList(urls: string[]): Promise<void> {
  return Promise.all(urls.map(preloadTexture)).then(() => undefined);
}
