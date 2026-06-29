/**
 * assetIO.ts — platform-neutral asset byte/texture-source fetch (ASSET_PACKAGING §4.1).
 *
 * Every place that turns a webpack-emitted asset URL into bytes (.tao ZIP, JSON)
 * or a PIXI BaseTexture source goes through this single indirection, so the WeChat
 * mini-game can swap in a CDN-download + local-cache strategy (plan A) without the
 * call sites knowing. The default WebAssetIO is a thin pass-through, so Web /
 * CrazyGames behaviour is byte-for-byte unchanged (fetch / identity url).
 */

export interface AssetIO {
  /** Raw bytes for an asset (used for .tao ZIP bundles, JSON). */
  loadBinary(url: string): Promise<ArrayBuffer>;
  /**
   * A source string usable as a PIXI BaseTexture/Image source.
   * Web: the url itself. WeChat: a cached local file path under USER_DATA_PATH.
   */
  textureSource(url: string): Promise<string>;
}

/** Web / CrazyGames: fetch bytes; texture source is the url as-is. */
class WebAssetIO implements AssetIO {
  async loadBinary(url: string): Promise<ArrayBuffer> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`assetIO: failed to fetch ${url} (${resp.status})`);
    return resp.arrayBuffer();
  }

  async textureSource(url: string): Promise<string> {
    return url;
  }
}

let _io: AssetIO = new WebAssetIO();

/** Install a platform-specific AssetIO (e.g. WechatAssetIO). Call once at boot. */
export function setAssetIO(io: AssetIO): void {
  _io = io;
}

/** The active AssetIO (WebAssetIO until a platform installs its own). */
export function assetIO(): AssetIO {
  return _io;
}
