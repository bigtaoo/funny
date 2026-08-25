import type * as PIXI from 'pixi.js-legacy';
import { IPlatform, IStorage, AuthCredential, IGameSocket, SocketHandlers, ShareResult } from '../IPlatform';
import { InputManager } from '../../inputSystem/InputManager';
import { WechatAdapter } from '../../inputSystem/WechatAdapter';
import type { Locale } from '../../i18n';
import type { IapKind } from '../iap';
import type { NetworkKind } from '../../assets/prefetchPolicy';
import { reportAnomaly } from '../../net/anomaly';

/**
 * WeChat mini-game platform adapter.
 * Requires @pixi/unsafe-eval to be imported before pixi.js-legacy.
 * The WeChat runtime provides a global `canvas` object instead of DOM.
 */

declare const wx: {
  getSystemInfoSync(): { windowWidth: number; windowHeight: number; language?: string };
  setPreferredFramesPerSecond(fps: number): void;
  getStorageSync(key: string): string | undefined;
  setStorageSync(key: string, value: string): void;
  removeStorageSync(key: string): void;
  getStorageInfoSync(): { currentSize: number; limitSize: number; keys: string[] };
  onTouchStart(cb: (res: WxTouchEvent) => void): void;
  onTouchEnd(cb: (res: WxTouchEvent) => void): void;
  onTouchMove(cb: (res: WxTouchEvent) => void): void;
  onTouchCancel(cb: (res: WxTouchEvent) => void): void;
  login(opts: {
    success(res: { code: string }): void;
    fail(err: unknown): void;
  }): void;
  connectSocket(opts: { url: string }): WxSocketTask;
  shareAppMessage(opts: { title?: string; query?: string; imageUrl?: string }): void;
  getLaunchOptionsSync(): { query?: Record<string, string> };
  createRewardedVideoAd(opts: { adUnitId: string }): WxRewardedVideoAd;
  getNetworkType(opts: { success?: (res: { networkType: string }) => void; fail?: (err: unknown) => void }): void;
};

/** Rewarded-video-ad instance (WeChat mini-game ads API). One instance is reused across watches. */
interface WxRewardedVideoAd {
  load(): Promise<void>;
  show(): Promise<void>;
  onLoad(cb: () => void): void;
  onError(cb: (err: { errCode: number; errMsg: string }) => void): void;
  /** `res.isEnded === true` (or `res` absent on some client versions) → watched to completion; `false` → skipped early, no reward. */
  onClose(cb: (res?: { isEnded: boolean }) => void): void;
  offClose(cb: (res?: { isEnded: boolean }) => void): void;
}

/**
 * WeChat mini-game rewarded-video ad unit id (mp.weixin.qq.com → 广告 → 激励视频广告).
 * Left blank until ops creates the ad unit for this appId — showRewardedAd() no-ops (resolves
 * null) while empty, matching PARALLEL_DEV_PLAN.md C2 / ECONOMY_BALANCE_CN.md's "替代 AdMob" TODO.
 */
const WECHAT_REWARDED_AD_UNIT_ID = '';

/** SocketTask returned by wx.connectSocket (subset of fields actually used). */
interface WxSocketTask {
  send(opts: { data: ArrayBuffer }): void;
  close(opts?: { code?: number; reason?: string }): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (res: { data: ArrayBuffer | string }) => void): void;
  onClose(cb: (res: { code: number; reason: string }) => void): void;
  onError(cb: (err: unknown) => void): void;
}

interface WxTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}
interface WxTouchEvent {
  changedTouches: WxTouch[];
}

// WeChat mini-game exposes a global canvas
declare const canvas: HTMLCanvasElement;

class WechatStorage implements IStorage {
  getItem(key: string): string | null {
    try {
      return wx.getStorageSync(key) ?? null;
    } catch {
      return null;
    }
  }
  setItem(key: string, value: string): void {
    try {
      wx.setStorageSync(key, value);
    } catch (e) {
      // WeChat's ~10MB per-mini-game storage quota throws here on overflow — previously swallowed
      // entirely silently (audit 2026-07-29), so a save that failed to persist looked identical to
      // one that succeeded until the player lost progress on relaunch. `getStorageInfoSync` is
      // best-effort (itself wrapped) purely for diagnostics in the report — never lets a failure
      // here throw back into the caller (IStorage.setItem must never throw).
      let usage: { currentSize?: number; limitSize?: number } = {};
      try { const info = wx.getStorageInfoSync(); usage = { currentSize: info.currentSize, limitSize: info.limitSize }; }
      catch { /* diagnostics only */ }
      reportAnomaly('jserror', `[wechat-storage] setItem('${key}') failed`, { err: String(e), ...usage });
    }
  }
  removeItem(key: string): void {
    try { wx.removeStorageSync(key); } catch { /* ignore */ }
  }
}

export class WechatPlatform implements IPlatform {
  readonly storage: IStorage = new WechatStorage();

  /** WeChat mini-game only ships Chinese. */
  readonly supportedLocales: readonly Locale[] = ['zh'];

  /**
   * WeChat canvas is already at physical pixel resolution — no scaling needed.
   */
  readonly devicePixelRatio: number = 1;

  getCanvas(): HTMLCanvasElement {
    return canvas;
  }

  getScreenSize(): { width: number; height: number } {
    const info = wx.getSystemInfoSync();
    return { width: info.windowWidth, height: info.windowHeight };
  }

  getLanguage(): string {
    try {
      return wx.getSystemInfoSync().language ?? 'zh-CN';
    } catch {
      return 'zh-CN';
    }
  }

  /**
   * Link type for the speculative-prefetch decision (ASSET_PACKAGING §14).
   *
   * WeChat is the one platform where this is answerable properly: `navigator.connection` — the
   * web's only source, and Chromium-only there — does not exist in this runtime, so before this
   * the mini-game fell through to "unknown link" and prefetched unconditionally on any connection.
   * `wx.getNetworkType` is a first-class API and was simply never called anywhere in the codebase.
   *
   * Only '2g' maps to `slow`; 3g and up stay `cellular`, which does NOT skip the prefetch. That
   * boundary is deliberate and matches the web path — see `prefetchPolicy.shouldSkipPrefetch` for
   * why "anything short of wifi" is the wrong rule. Unrecognised values (the list gained '5g'
   * after launch and can gain more) fall to `unknown`, i.e. behave as a normal link.
   */
  getNetworkKind(): Promise<NetworkKind> {
    return new Promise<NetworkKind>((resolve) => {
      try {
        wx.getNetworkType({
          success: ({ networkType }) => {
            if (networkType === 'wifi') resolve('wifi');
            else if (networkType === 'none') resolve('none');
            else if (networkType === '2g') resolve('slow');
            else if (/^\dg$/.test(networkType)) resolve('cellular');
            else resolve('unknown');
          },
          // Never reject: a failed probe must degrade to "normal link", the same as a platform
          // that cannot answer at all. The per-feature marks are what keep that case honest.
          fail: () => resolve('unknown'),
        });
      } catch {
        resolve('unknown');
      }
    });
  }

  /**
   * WeChat: wx.onTouch* events → InputManager via WechatAdapter.
   */
  setupInput(
    _app: PIXI.Application,
    input: InputManager,
    toDesign: (sx: number, sy: number) => { x: number; y: number },
  ): void {
    new WechatAdapter(input, toDesign);
  }

  async onLoadingComplete(): Promise<void> { /* no-op */ }
  onGameplayStart(): void { /* no-op */ }
  onGameplayStop(): void  { /* no-op */ }
  async showMidgameAd(): Promise<void> { /* no-op */ }

  /** True only once ops has configured a real ad unit id — the DailyScene "Ads" tab stays hidden until then. */
  hasRewardedAd(): boolean {
    return !!WECHAT_REWARDED_AD_UNIT_ID;
  }

  /** Lazily created and reused — WeChat recommends one long-lived instance per ad unit, not one per watch. */
  private rewardedAd: WxRewardedVideoAd | null = null;

  showRewardedAd(_accountId: string): Promise<{ adToken: string; platform: string } | null> {
    if (!WECHAT_REWARDED_AD_UNIT_ID) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const ad = this.rewardedAd ?? wx.createRewardedVideoAd({ adUnitId: WECHAT_REWARDED_AD_UNIT_ID });
        this.rewardedAd = ad;
        let settled = false;
        const onClose = (res?: { isEnded: boolean }) => {
          ad.offClose(onClose);
          if (settled) return;
          settled = true;
          const watched = res === undefined || res.isEnded === true;
          resolve(watched ? { adToken: `wx-${Date.now()}-${Math.random().toString(36).slice(2)}`, platform: 'wechat_client' } : null);
        };
        ad.onClose(onClose);
        ad.load()
          .then(() => ad.show())
          .catch(() => { if (!settled) { settled = true; ad.offClose(onClose); resolve(null); } });
      } catch {
        resolve(null);
      }
    });
  }

  /** wx.login → temporary code; exchange with server /auth/wx for openid → accountId (S0-4). */
  getAuthCredential(): Promise<AuthCredential> {
    return new Promise((resolve, reject) => {
      try {
        wx.login({
          success: (res) => resolve({ kind: 'wx', code: res.code }),
          fail: (e) => reject(e),
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  connectSocket(url: string, handlers: SocketHandlers): IGameSocket {
    const task = wx.connectSocket({ url });
    task.onOpen(() => handlers.onOpen());
    task.onMessage((res) => {
      if (res.data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(res.data));
    });
    task.onClose((res) => handlers.onClose(res.code, res.reason));
    task.onError((err) => handlers.onError(err));
    return new WechatGameSocket(task);
  }

  onAppReady(): void {
    try { wx.setPreferredFramesPerSecond(60); } catch { /* ignore */ }
  }

  /** Cannot share arbitrary external links: sends a game card into chat; recipients open the mini-game and read query.r to reach the player directly (§4.1). */
  async shareReplay(shareCode: string, title: string): Promise<ShareResult> {
    try {
      wx.shareAppMessage({ title, query: `r=${shareCode}` });
    } catch { /* ignore */ }
    return { method: 'card' };
  }

  getLaunchShareCode(): string | null {
    try {
      return wx.getLaunchOptionsSync().query?.r ?? null;
    } catch {
      return null;
    }
  }

  // ── In-app coin recharge ────────────────────────────────────────────────────
  // WeChat Pay (wx.requestPayment) is a separate channel left as a TODO — the shop's
  // Coins tab stays hidden here, and promo codes remain the only in-client top-up.
  iapKind(): IapKind | null { return null; }
  openPaddleCheckout(): Promise<{ completed: boolean }> {
    return Promise.reject(new Error('paddle checkout not supported on WeChat'));
  }
  nativeIapPurchase(): Promise<{ receipt: string }> {
    return Promise.reject(new Error('native IAP not supported on WeChat'));
  }
}

/** WeChat mini-game binary WS handle (S1-6). After an intentional close, callbacks are ignored by the NetClient guard. */
class WechatGameSocket implements IGameSocket {
  private closed = false;
  constructor(private readonly task: WxSocketTask) {}

  send(data: Uint8Array): void {
    if (this.closed) return;
    // SocketTask.send requires ArrayBuffer; slice out an exact view to avoid carrying over extra bytes from the underlying buffer
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    try {
      this.task.send({ data: buf });
    } catch {
      /* ignore */
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.task.close();
    } catch {
      /* ignore */
    }
  }
}
