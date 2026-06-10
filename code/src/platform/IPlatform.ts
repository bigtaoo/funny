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
}

export interface IStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
