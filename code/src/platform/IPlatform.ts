import type * as PIXI from 'pixi.js-legacy';

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
   * Called once after the PIXI Application is created.
   * Web: no-op — PIXI EventSystem auto-attaches to DOM canvas events.
   * WeChat: forwards wx.onTouch* events into PIXI's EventSystem.
   */
  setupInput(app: PIXI.Application): void;

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
}

export interface IStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
