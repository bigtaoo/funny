import { InputManager } from './InputManager';

declare const wx: {
  onTouchStart(cb: (e: { changedTouches: Array<{ clientX: number; clientY: number }> }) => void): void;
  onTouchMove(cb:  (e: { changedTouches: Array<{ clientX: number; clientY: number }> }) => void): void;
  onTouchEnd(cb:   (e: { changedTouches: Array<{ clientX: number; clientY: number }> }) => void): void;
  onTouchCancel(cb:(e: { changedTouches: Array<{ clientX: number; clientY: number }> }) => void): void;
};

/**
 * WechatAdapter — converts wx.onTouch* callbacks to design-space coords.
 *
 * WeChat mini-games don't have a DOM so PIXI's EventSystem doesn't work.
 * This adapter intercepts wx touch events and feeds them into InputManager.
 *
 * Only the first touch (changedTouches[0]) is used — single-touch game.
 *
 * @param input     InputManager to emit into.
 * @param toDesign  Function that converts screen coords to design space.
 */
export class WechatAdapter {
  constructor(
    input: InputManager,
    toDesign: (sx: number, sy: number) => { x: number; y: number },
  ) {
    wx.onTouchStart(e => {
      const t = e.changedTouches[0];
      if (!t) return;
      const r = toDesign(t.clientX, t.clientY);
      input._emitDown(r.x, r.y);
    });

    wx.onTouchMove(e => {
      const t = e.changedTouches[0];
      if (!t) return;
      const r = toDesign(t.clientX, t.clientY);
      input._emitMove(r.x, r.y);
    });

    wx.onTouchEnd(e => {
      const t = e.changedTouches[0];
      if (!t) return;
      const r = toDesign(t.clientX, t.clientY);
      input._emitUp(r.x, r.y);
    });

    wx.onTouchCancel(e => {
      const t = e.changedTouches[0];
      if (!t) return;
      const r = toDesign(t.clientX, t.clientY);
      input._emitUp(r.x, r.y); // treat cancel as up
    });
  }
}
