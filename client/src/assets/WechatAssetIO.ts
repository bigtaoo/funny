/**
 * WechatAssetIO — WeChat mini-game plan A (ASSET_PACKAGING §4.1).
 *
 * L1 (and, once the build splits them out, all non-trivial) assets are NOT packed
 * into the 4 MB main package; they live on a CDN. At runtime each asset is fetched
 * once via wx.downloadFile, persisted to USER_DATA_PATH, and served from that local
 * cache thereafter. The webpack-emitted url carries a contenthash basename that is
 * stable across a build, so it doubles as both the CDN path and the cache key.
 *
 * Installed by entries/wechat.ts only when a CDN base is configured
 * (__NW_ASSET_CDN__); otherwise the default WebAssetIO keeps serving packed assets.
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

export class WechatAssetIO implements AssetIO {
  private readonly cdnBase: string;
  private readonly cacheDir: string;
  private readonly fs: WxFileSystemManager;
  /** De-dupe concurrent fetches of the same asset (mirrors PIXI/Stickman url caches). */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(cdnBase: string) {
    this.cdnBase = cdnBase.replace(/\/+$/, '');
    this.fs = wx.getFileSystemManager();
    this.cacheDir = `${wx.env.USER_DATA_PATH}/nwassets`;
    try { this.fs.accessSync(this.cacheDir); }
    catch { try { this.fs.mkdirSync(this.cacheDir, true); } catch { /* best-effort */ } }
  }

  async loadBinary(url: string): Promise<ArrayBuffer> {
    const local = await this.ensureLocal(url);
    return this.fs.readFileSync(local);
  }

  async textureSource(url: string): Promise<string> {
    return this.ensureLocal(url);
  }

  /** Resolve `url` to a local cached path, downloading from the CDN on a miss. */
  private ensureLocal(url: string): Promise<string> {
    const name = url.split(/[?#]/)[0]!.split('/').pop() || url;
    const dest = `${this.cacheDir}/${name}`;

    // Cache hit — file already on disk.
    try { this.fs.accessSync(dest); return Promise.resolve(dest); } catch { /* miss → download */ }

    const existing = this.inflight.get(dest);
    if (existing) return existing;

    const p = new Promise<string>((resolve, reject) => {
      wx.downloadFile({
        url: `${this.cdnBase}/${name}`,
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
