/**
 * IPlatform — abstraction layer for platform-specific capabilities.
 * Implemented by WebPlatform and WechatPlatform.
 */
export interface IPlatform {
  /** Returns the canvas element Pixi.js should render into */
  getCanvas(): HTMLCanvasElement;

  /** Screen dimensions in CSS pixels */
  getScreenSize(): { width: number; height: number };

  /** Persistent key-value storage */
  storage: IStorage;

  /** Called after Pixi app is created — platform may set up orientation lock etc. */
  onAppReady(): void;
}

export interface IStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
