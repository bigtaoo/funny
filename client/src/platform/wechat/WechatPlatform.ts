import type * as PIXI from 'pixi.js-legacy';
import { IPlatform, IStorage, AuthCredential, IGameSocket, SocketHandlers } from '../IPlatform';
import { InputManager } from '../../inputSystem/InputManager';
import { WechatAdapter } from '../../inputSystem/WechatAdapter';
import type { Locale } from '../../i18n';
import type { IapKind } from '../iap';

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
};

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
    try { wx.setStorageSync(key, value); } catch { /* ignore */ }
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
  async shareReplay(shareCode: string, title: string): Promise<void> {
    try {
      wx.shareAppMessage({ title, query: `r=${shareCode}` });
    } catch { /* ignore */ }
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
