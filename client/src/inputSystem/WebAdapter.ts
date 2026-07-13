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
      const r = toDesign(e.clientX, e.clientY);
      input._emitDown(r.x, r.y);
    });

    add(canvas, 'pointermove', e => {
      const r = toDesign(e.clientX, e.clientY);
      input._emitMove(r.x, r.y);
    });

    // Listen on window so releases outside canvas are caught
    add(window, 'pointerup', e => {
      const r = toDesign(e.clientX, e.clientY);
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
      const r = toDesign(e.clientX, e.clientY);
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
