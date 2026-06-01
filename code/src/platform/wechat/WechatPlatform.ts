import type * as PIXI from 'pixi.js-legacy';
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
   * WeChat: bridge wx.onTouch* events into PIXI's EventSystem.
   *
   * PIXI's EventSystem attaches PointerEvent listeners to the DOM canvas, but
   * the wx canvas is NOT a real DOM element and never fires those events.
   * We synthesise PointerEvent-shaped objects and hand them directly to the
   * EventSystem's internal handlers so that interactive containers and
   * `pointertap` callbacks work exactly like on web.
   */
  setupInput(app: PIXI.Application): void {
    // PIXI v7 exposes the EventSystem at app.renderer.events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = (app.renderer as any).events as {
      onPointerDown(e: PointerEvent): void;
      onPointerUp(e: PointerEvent): void;
      onPointerMove(e: PointerEvent): void;
      onPointerCancel(e: PointerEvent): void;
    };

    if (!events) {
      console.warn('[WechatPlatform] PIXI EventSystem not found — input disabled');
      return;
    }

    const makePointerEvent = (type: string, touch: WxTouch): PointerEvent =>
      // PointerEvent constructor is available in WeChat runtime (Chromium-based)
      new PointerEvent(type, {
        pointerId: touch.identifier,
        clientX: touch.clientX,
        clientY: touch.clientY,
        isPrimary: touch.identifier === 0,
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
      });

    wx.onTouchStart((res) => {
      for (const t of res.changedTouches) {
        events.onPointerDown(makePointerEvent('pointerdown', t));
      }
    });

    wx.onTouchEnd((res) => {
      for (const t of res.changedTouches) {
        events.onPointerUp(makePointerEvent('pointerup', t));
      }
    });

    wx.onTouchMove((res) => {
      for (const t of res.changedTouches) {
        events.onPointerMove(makePointerEvent('pointermove', t));
      }
    });

    wx.onTouchCancel((res) => {
      for (const t of res.changedTouches) {
        events.onPointerCancel(makePointerEvent('pointercancel', t));
      }
    });
  }

  async onLoadingComplete(): Promise<void> { /* no-op */ }
  onGameplayStart(): void { /* no-op */ }
  onGameplayStop(): void  { /* no-op */ }
  async showMidgameAd(): Promise<void> { /* no-op */ }

  onAppReady(): void {
    try { wx.setPreferredFramesPerSecond(60); } catch { /* ignore */ }
  }
}
