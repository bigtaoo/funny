import type * as PIXI from 'pixi.js-legacy';
import { IPlatform, IStorage } from '../IPlatform';
import { InputManager } from '../../inputSystem/InputManager';
import { WechatAdapter } from '../../inputSystem/WechatAdapter';

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
  onTouchStart(cb: (res: WxTouchEvent) => void): void;
  onTouchEnd(cb: (res: WxTouchEvent) => void): void;
  onTouchMove(cb: (res: WxTouchEvent) => void): void;
  onTouchCancel(cb: (res: WxTouchEvent) => void): void;
};

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

  onAppReady(): void {
    try { wx.setPreferredFramesPerSecond(60); } catch { /* ignore */ }
  }
}
