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
import { reportAnomaly } from '../net/anomaly';

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

interface WxFileStats {
  size: number;
  isDirectory(): boolean;
}

interface WxFileSystemManager {
  accessSync(path: string): void; // throws if absent
  mkdirSync(dirPath: string, recursive?: boolean): void;
  saveFileSync(tempFilePath: string, filePath: string): string;
  readFileSync(filePath: string): ArrayBuffer;
  /** Overload used only for the JSON GC index — `encoding` makes WeChat return a string, not a buffer. */
  readFileSync(filePath: string, encoding: 'utf8'): string;
  writeFileSync(filePath: string, data: string, encoding: 'utf8'): void;
  readdirSync(dirPath: string): string[];
  statSync(path: string): WxFileStats;
  unlinkSync(filePath: string): void;
}

/** A baked-in absolute CDN url (vs a package-relative path for no-CDN builds). */
function isRemote(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Soft budget for `USER_DATA_PATH/nwassets` (audit 2026-07-29, client-resource-mgmt-audit memory):
 * every resource-version bump mints new contenthash filenames, and nothing ever deleted the old
 * ones — the directory only grew, risking WeChat's small per-mini-game user-data quota. ~30MB
 * gives a few versions' worth of headroom over ASSET_PACKAGING's ~5MB L1 CDN footprint before GC
 * kicks in (not a hard cap — WeChat's own quota is authoritative; this just keeps us well clear of it).
 */
const MAX_CACHE_BYTES = 30 * 1024 * 1024;
const INDEX_FILE = '.index.json';

export class WechatAssetIO implements AssetIO {
  private readonly cacheDir: string;
  private readonly fs: WxFileSystemManager;
  /** De-dupe concurrent fetches of the same asset (mirrors PIXI/Stickman url caches). */
  private readonly inflight = new Map<string, Promise<string>>();
  /**
   * filename → last-accessed epoch ms, persisted alongside the cache as `.index.json`. Used only to
   * pick GC eviction order (oldest-touched first) — never a correctness dependency: a missing/corrupt
   * index just makes every file look equally old (evicted in directory-listing order instead), it
   * never blocks a load.
   */
  private index: Record<string, number> = {};

  constructor() {
    this.fs = wx.getFileSystemManager();
    this.cacheDir = `${wx.env.USER_DATA_PATH}/nwassets`;
    try { this.fs.accessSync(this.cacheDir); }
    catch { try { this.fs.mkdirSync(this.cacheDir, true); } catch { /* best-effort */ } }
    this.loadIndex();
    this.gcIfOverBudget();
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
    try { this.fs.accessSync(dest); this.touch(name); return Promise.resolve(dest); } catch { /* miss → download */ }

    const existing = this.inflight.get(dest);
    if (existing) return existing;

    const p = new Promise<string>((resolve, reject) => {
      wx.downloadFile({
        url,
        success: (res) => {
          if (res.statusCode !== 200) { reject(new Error(`WechatAssetIO: ${name} HTTP ${res.statusCode}`)); return; }
          try {
            resolve(this.fs.saveFileSync(res.tempFilePath, dest));
            this.touch(name);
          } catch (e) {
            // Falls back to the temp file so this load still succeeds — but a persistent-cache write
            // failure silently defeats the whole point of the cache (every cold start re-downloads),
            // and previously nothing ever surfaced that. Report it (best-effort, never rethrown).
            reportAnomaly('jserror', '[wechat-asset-cache] saveFileSync failed, using temp file', {
              name, err: String(e),
            });
            resolve(res.tempFilePath);
          }
        },
        fail: (err) => reject(err instanceof Error ? err : new Error(`WechatAssetIO: download ${name} failed`)),
      });
    }).finally(() => { this.inflight.delete(dest); });

    this.inflight.set(dest, p);
    return p;
  }

  private touch(name: string): void {
    this.index[name] = Date.now();
    try { this.fs.writeFileSync(`${this.cacheDir}/${INDEX_FILE}`, JSON.stringify(this.index), 'utf8'); }
    catch { /* best-effort — losing the index only degrades GC ordering, never correctness */ }
  }

  private loadIndex(): void {
    try {
      const raw = this.fs.readFileSync(`${this.cacheDir}/${INDEX_FILE}`, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') this.index = parsed as Record<string, number>;
    } catch { this.index = {}; /* absent/corrupt index — every file just sorts as equally old below */ }
  }

  /**
   * Best-effort LRU-ish GC: once the cache dir exceeds MAX_CACHE_BYTES, delete the
   * least-recently-touched files (per `index`; untracked files — e.g. cached before this fix
   * shipped — sort first, so pre-existing orphans are the first thing reclaimed) until back under
   * budget. Runs once per session at construction; every FS call is individually try/catch'd so a
   * single failure can't cascade, and the whole pass can never block or delay asset loading (it's
   * fully synchronous, called before any `ensureLocal` request is issued).
   */
  private gcIfOverBudget(): void {
    try {
      const names = this.fs.readdirSync(this.cacheDir).filter((n) => n !== INDEX_FILE);
      const entries = names.map((name) => {
        let size = 0;
        try {
          const st = this.fs.statSync(`${this.cacheDir}/${name}`);
          if (!st.isDirectory()) size = st.size;
        } catch { /* file vanished mid-scan; treat as zero-size, still eligible for index cleanup */ }
        return { name, size, lastAccessedAt: this.index[name] ?? 0 };
      });
      let total = entries.reduce((sum, e) => sum + e.size, 0);
      if (total <= MAX_CACHE_BYTES) return;

      entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt); // oldest / never-tracked first
      let removed = 0;
      for (const e of entries) {
        if (total <= MAX_CACHE_BYTES) break;
        try {
          this.fs.unlinkSync(`${this.cacheDir}/${e.name}`);
          total -= e.size;
          removed++;
          delete this.index[e.name];
        } catch { /* best-effort; leave it and keep going */ }
      }
      if (removed > 0) {
        reportAnomaly('jserror', '[wechat-asset-cache] GC evicted stale files over budget', {
          removed, budgetMB: Math.round(MAX_CACHE_BYTES / 1_048_576),
        });
        try { this.fs.writeFileSync(`${this.cacheDir}/${INDEX_FILE}`, JSON.stringify(this.index), 'utf8'); }
        catch { /* best-effort */ }
      }
    } catch (e) {
      reportAnomaly('jserror', '[wechat-asset-cache] GC pass failed', { err: String(e) });
    }
  }
}
