import { InputManager } from './InputManager';

/**
 * WebAdapter — converts browser PointerEvents on a canvas to design-space coords.
 *
 * @param canvas     The game canvas element.
 * @param input      InputManager to emit into.
 * @param toDesign   Function that converts screen (CSS pixel) coords to design space.
 *
 * Uses pointer events (not mouse/touch) for unified desktop + mobile support.
 * pointerup is on window so releases outside the canvas are caught.
 *
 * Coordinates are taken relative to the canvas's own on-screen rect, not the viewport. The two only
 * differ when the document has scrolled, which the game never does on purpose — but iOS WKWebView
 * does it for us: focusing the hidden text `<input>` (platform/web/domTextInput.ts) scrolls the page
 * up to keep it above the soft keyboard, and the scroll is not always undone when the keyboard
 * closes. Mapping raw `clientX/Y` then put every tap hundreds of design px away from the button the
 * player could see, so a fresh install that had just typed its login saw a lobby where nothing
 * responded (TestFlight build 14, 2026-10-03). Reading the rect makes the tap land on what is drawn
 * wherever the canvas currently sits.
 */
export class WebAdapter {
  private readonly canvas: HTMLCanvasElement;
  private readonly handlers: Array<{ target: EventTarget; type: string; fn: EventListener }> = [];

  constructor(
    canvas: HTMLCanvasElement,
    input: InputManager,
    toDesign: (sx: number, sy: number) => { x: number; y: number },
  ) {
    this.canvas = canvas;
    const toLocal = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return toDesign(e.clientX - rect.left, e.clientY - rect.top);
    };

    const add = (
      target: EventTarget,
      type: string,
      fn: (e: PointerEvent) => void,
    ) => {
      const listener = fn as EventListener;
      target.addEventListener(type, listener, { passive: false });
      this.handlers.push({ target, type, fn: listener });
    };

    add(canvas, 'pointerdown', e => {
      e.preventDefault();
      const r = toLocal(e);
      input._emitDown(r.x, r.y);
    });

    add(canvas, 'pointermove', e => {
      const r = toLocal(e);
      input._emitMove(r.x, r.y);
    });

    // Listen on window so releases outside canvas are caught
    add(window, 'pointerup', e => {
      const r = toLocal(e);
      input._emitUp(r.x, r.y);
    });

    add(canvas, 'contextmenu', e => { e.preventDefault(); });

    const addWheel = (target: EventTarget, type: string, fn: (e: WheelEvent) => void) => {
      const listener = fn as EventListener;
      target.addEventListener(type, listener, { passive: false });
      this.handlers.push({ target, type, fn: listener });
    };
    addWheel(canvas, 'wheel', e => {
      e.preventDefault();
      const r = toLocal(e);
      input._emitWheel(r.x, r.y, e.deltaY);
    });
  }

  destroy(): void {
    for (const { target, type, fn } of this.handlers) {
      target.removeEventListener(type, fn);
    }
    this.handlers.length = 0;
  }
}
