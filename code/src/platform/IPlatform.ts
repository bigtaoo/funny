import type * as PIXI from 'pixi.js-legacy';

/**
 * IPlatform — abstraction layer for platform-specific capabilities.
 * Implemented by WebPlatform and WechatPlatform.
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
   * WeChat: forwards wx.onTouch* events into PIXI's EventSystem so that
   *         interactive containers (c.interactive / c.on('pointertap'))
   *         work identically on both platforms.
   */
  setupInput(app: PIXI.Application): void;

  /** Called after Pixi app is created — platform may set up orientation lock etc. */
  onAppReady(): void;
}

export interface IStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
