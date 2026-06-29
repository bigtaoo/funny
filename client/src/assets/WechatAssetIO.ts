/**
 * WechatAssetIO — WeChat mini-game asset IO (ASSET_PACKAGING §4).
 *
 * WeChat has no `fetch`, so every asset byte/texture-source request goes through
 * wx.downloadFile + a USER_DATA_PATH local cache. Asset URLs are baked at build
 * time by webpack's asset/resource `publicPath`:
 *   - plan A (NW_ASSET_CDN set): absolute CDN url, e.g. https://cdn.example/cdn/<hash>.png
 *     → downloaded once, then served from local cache.
 *   - no CDN (local IDE full-package build): a package-relative path, e.g. cdn/<hash>.png
 *     → read straight from the package (no download).
 * The contenthash basename is unique, so it doubles as the cache key.
 *
 * Installed unconditionally by entries/wechat.ts (WeChat always needs this, CDN or
 * not). On Web the default WebAssetIO (fetch / identity) stays in force.
 */
import type { AssetIO } from './assetIO';

// Minimal slice of the wx API surface this file uses.
declare const wx: {
  env: { USER_DATA_PATH: string };
  downloadFile(opts: {
    url: string;
    success(res: { statusCode: number; tempFilePath: string }): void;
    fail(err: unknown): void;
  }): void;
  getFileSystemManager(): WxFileSystemManager;
};

interface WxFileSystemManager {
  accessSync(path: string): void; // throws if absent
  mkdirSync(dirPath: string, recursive?: boolean): void;
  saveFileSync(tempFilePath: string, filePath: string): string;
  readFileSync(filePath: string): ArrayBuffer;
}

/** A baked-in absolute CDN url (vs a package-relative path for no-CDN builds). */
function isRemote(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export class WechatAssetIO implements AssetIO {
  private readonly cacheDir: string;
  private readonly fs: WxFileSystemManager;
  /** De-dupe concurrent fetches of the same asset (mirrors PIXI/Stickman url caches). */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor() {
    this.fs = wx.getFileSystemManager();
    this.cacheDir = `${wx.env.USER_DATA_PATH}/nwassets`;
    try { this.fs.accessSync(this.cacheDir); }
    catch { try { this.fs.mkdirSync(this.cacheDir, true); } catch { /* best-effort */ } }
  }

  async loadBinary(url: string): Promise<ArrayBuffer> {
    if (!isRemote(url)) return this.fs.readFileSync(url); // in-package file
    const local = await this.ensureLocal(url);
    return this.fs.readFileSync(local);
  }

  async textureSource(url: string): Promise<string> {
    if (!isRemote(url)) return url; // in-package path — PIXI loads it directly
    return this.ensureLocal(url);
  }

  /** Resolve a remote `url` to a local cached path, downloading on a miss. */
  private ensureLocal(url: string): Promise<string> {
    const name = url.split(/[?#]/)[0]!.split('/').pop() || encodeURIComponent(url);
    const dest = `${this.cacheDir}/${name}`;

    // Cache hit — file already on disk.
    try { this.fs.accessSync(dest); return Promise.resolve(dest); } catch { /* miss → download */ }

    const existing = this.inflight.get(dest);
    if (existing) return existing;

    const p = new Promise<string>((resolve, reject) => {
      wx.downloadFile({
        url,
        success: (res) => {
          if (res.statusCode !== 200) { reject(new Error(`WechatAssetIO: ${name} HTTP ${res.statusCode}`)); return; }
          try { resolve(this.fs.saveFileSync(res.tempFilePath, dest)); }
          catch { resolve(res.tempFilePath); /* fall back to temp file if save fails */ }
        },
        fail: (err) => reject(err instanceof Error ? err : new Error(`WechatAssetIO: download ${name} failed`)),
      });
    }).finally(() => { this.inflight.delete(dest); });

    this.inflight.set(dest, p);
    return p;
  }
}
