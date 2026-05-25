import { IPlatform, IStorage } from '../IPlatform';

/**
 * WeChat mini-game platform adapter.
 * Requires @pixi/unsafe-eval to be imported before pixi.js-legacy.
 * The WeChat runtime provides a global `canvas` object instead of DOM.
 */

declare const wx: {
  getSystemInfoSync(): { windowWidth: number; windowHeight: number };
  setPreferredFramesPerSecond(fps: number): void;
  getStorageSync(key: string): string | undefined;
  setStorageSync(key: string, value: string): void;
  removeStorageSync(key: string): void;
};

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

  getCanvas(): HTMLCanvasElement {
    return canvas;
  }

  getScreenSize(): { width: number; height: number } {
    const info = wx.getSystemInfoSync();
    return { width: info.windowWidth, height: info.windowHeight };
  }

  onAppReady(): void {
    // Lock frame rate on WeChat (saves battery)
    try { wx.setPreferredFramesPerSecond(60); } catch { /* ignore */ }
  }
}
