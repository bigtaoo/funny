/**
 * preloadTextures.ts — shared L0/L1 texture preload helper (ASSET_PACKAGING §4.1).
 *
 * Wraps `assetIO().textureSource(url)` → `PIXI.BaseTexture.from(src)` and registers
 * the result under the ORIGINAL url as an alias when src ≠ url (WeChat local-file
 * case). Without the alias, `PIXI.Texture.from(url)` misses the cache and re-fetches
 * from CDN every session. Web is unaffected (src === url, alias is a no-op).
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from './assetIO';

export function preloadTexture(url: string): Promise<void> {
  return assetIO().textureSource(url).then((src) => new Promise<void>((resolve) => {
    const baseTex = PIXI.BaseTexture.from(src);
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
