import type * as PIXI from 'pixi.js-legacy';
import type { InputManager } from '../inputSystem/InputManager';
import type { Locale } from '../i18n';

/**
 * IPlatform — abstraction layer for platform-specific capabilities.
 * Implemented per-platform: WebPlatform, WechatPlatform, CrazyGamesPlatform, …
 */
export interface IPlatform {
  /** Returns the canvas element Pixi.js should render into */
  getCanvas(): HTMLCanvasElement;

  /** Screen dimensions in CSS pixels */
  getScreenSize(): { width: number; height: number };

  /**
   * Physical pixel ratio for the display.
   * Web: window.devicePixelRatio
   * WeChat: always 1 (canvas is already at physical resolution)
   */
  devicePixelRatio: number;

  /** Persistent key-value storage */
  storage: IStorage;

  /**
   * Raw system language tag, e.g. "zh-CN" / "en-US".
   * Web: navigator.language
   * WeChat: wx.getSystemInfoSync().language
   * Used by i18n to pick the default locale (player choice overrides it).
   */
  getLanguage(): string;

  /**
   * Locales this platform ships translations for.
   * Web / CrazyGames: ['zh', 'en', 'de']
   * WeChat: ['zh'] — the mini-game only needs Chinese.
   * i18n clamps the active locale to this set.
   */
  readonly supportedLocales: readonly Locale[];

  /**
   * Called once after the PIXI Application is created.
   * Creates the platform-specific input adapter and wires it to the InputManager.
   *
   * Web / CrazyGames: creates WebAdapter (canvas pointer events).
   * WeChat: creates WechatAdapter (wx.onTouch* events).
   *
   * The `toDesign` function converts screen CSS-pixel coords to design-space coords.
   */
  setupInput(
    app: PIXI.Application,
    input: InputManager,
    toDesign: (sx: number, sy: number) => { x: number; y: number },
  ): void;

  /** Called after Pixi app is created — platform may set up orientation lock etc. */
  onAppReady(): void;

  // ── SDK lifecycle (ads, analytics) ──────────────────────────────────────────

  /** Called once after assets load — signals the platform that loading is done. */
  onLoadingComplete(): Promise<void>;

  /** Called when a gameplay session begins (match starts). */
  onGameplayStart(): void;

  /** Called when a gameplay session ends (game over / back to lobby). */
  onGameplayStop(): void;

  /**
   * Show a platform mid-game ad. Resolves when the ad finishes or is skipped.
   * No-op on platforms that don't support ads.
   */
  showMidgameAd(): Promise<void>;

  /**
   * Anonymous-account credential the client trades to the server for a JWT
   * + accountId (S0-4). Server-side: /auth/wx (code→openid) or /auth/device.
   *
   * Web / CrazyGames: a device UUID persisted in storage (stable per device).
   * WeChat: a fresh `wx.login` code each call (short-lived, server exchanges it).
   *
   * Returns the same kind every call on a given platform.
   */
  getAuthCredential(): Promise<AuthCredential>;

  /**
   * Open a binary WebSocket to the gameserver (S1-6). Platform abstracts the
   * underlying transport (browser `WebSocket` vs `wx.connectSocket`); reconnect
   * and protocol live in `NetClient`. Returns immediately; events arrive via
   * `handlers`. Binary frames are protobuf `Envelope` (transport.proto).
   *
   * Web / CrazyGames: global `WebSocket` (binaryType=arraybuffer).
   * WeChat: `wx.connectSocket` SocketTask.
   */
  connectSocket(url: string, handlers: SocketHandlers): IGameSocket;

  // ── 录像游戏外分享（REPLAY_SHARE_DESIGN §4）─────────────────────────────────

  /**
   * 分享一段状态流录像（REPLAY_SHARE_DESIGN §4.1/§4.3）。平台分叉：
   * - Web / CrazyGames：拼分享链接 `…?r=<shareCode>`，走 `navigator.share`，无则复制到剪贴板。
   * - WeChat：`wx.shareAppMessage({ query: 'r=<shareCode>' })` 发成游戏卡片进聊天（不外链）。
   *
   * 解析为分享动作已发起（或已复制）；失败时 reject。
   */
  shareReplay(shareCode: string, title: string): Promise<void>;

  /**
   * 读取启动参数里的录像分享码（REPLAY_SHARE_DESIGN §4.1）。命中则启动时跳过登录直达哑播放器。
   * - Web / CrazyGames：URL `?r=<shareCode>`。
   * - WeChat：`wx.getLaunchOptionsSync().query.r`。
   * 无则返回 null。
   */
  getLaunchShareCode(): string | null;
}

/** gameserver WS 事件回调（NetClient 提供，平台 socket 触发）。 */
export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: Uint8Array): void;
  onClose(code: number, reason: string): void;
  onError(err: unknown): void;
}

/** 平台无关的二进制 socket 句柄。 */
export interface IGameSocket {
  send(data: Uint8Array): void;
  close(): void;
}

/** Anonymous identity proof (S0-4). See IPlatform.getAuthCredential. */
export type AuthCredential =
  | { kind: 'device'; deviceId: string }
  | { kind: 'wx'; code: string };

export interface IStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
