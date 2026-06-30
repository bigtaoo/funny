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

  // ── Out-of-game replay sharing (REPLAY_SHARE_DESIGN §4) ─────────────────────

  /**
   * Share a state-stream replay (REPLAY_SHARE_DESIGN §4.1/§4.3). Platform branches:
   * - Web / CrazyGames: builds a share link `…?r=<shareCode>`, uses `navigator.share`,
   *   falls back to clipboard copy if unavailable.
   * - WeChat: `wx.shareAppMessage({ query: 'r=<shareCode>' })` sends it as a game card
   *   in chat (no external link).
   *
   * Resolves when the share action has been initiated (or copied); rejects on failure.
   */
  shareReplay(shareCode: string, title: string): Promise<void>;

  /**
   * Read the replay share code from launch parameters (REPLAY_SHARE_DESIGN §4.1).
   * If present, the app skips login at startup and navigates directly to the dumb player.
   * - Web / CrazyGames: URL `?r=<shareCode>`.
   * - WeChat: `wx.getLaunchOptionsSync().query.r`.
   * Returns null if absent.
   */
  getLaunchShareCode(): string | null;
}

/** gameserver WS event callbacks (provided by NetClient, triggered by the platform socket). */
export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: Uint8Array): void;
  onClose(code: number, reason: string): void;
  onError(err: unknown): void;
}

/** Platform-agnostic binary socket handle. */
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
