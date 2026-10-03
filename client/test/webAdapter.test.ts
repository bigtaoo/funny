import { describe, it, expect, afterEach } from 'vitest';
import { WebAdapter } from '../src/inputSystem/WebAdapter';
import { InputManager } from '../src/inputSystem/InputManager';

// WebAdapter maps pointer coordinates against the canvas's on-screen rect, not the viewport.
// Pinned because the two only diverge on a real phone: iOS WKWebView scrolls the document up when
// the hidden text input takes focus and does not always scroll it back, and with raw clientX/Y every
// tap then missed its button by the scroll distance (TestFlight build 14, 2026-10-03).

/** A canvas stand-in: an EventTarget whose on-screen rect the test controls. */
function fakeCanvas(rect: { left: number; top: number }): HTMLCanvasElement {
  const el = new EventTarget() as EventTarget & { getBoundingClientRect: () => DOMRect };
  el.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, width: 390, height: 844, right: 0, bottom: 0, toJSON: () => ({}) });
  return el as unknown as HTMLCanvasElement;
}

function pointer(type: string, clientX: number, clientY: number): Event {
  return Object.assign(new Event(type, { cancelable: true }), { clientX, clientY });
}

const g = globalThis as { window?: EventTarget };
const hadWindow = 'window' in g;
const savedWindow = g.window;

afterEach(() => {
  if (hadWindow) g.window = savedWindow;
  else delete g.window;
});

describe('WebAdapter', () => {
  function setup(rect: { left: number; top: number }) {
    g.window = new EventTarget();
    const canvas = fakeCanvas(rect);
    const input = new InputManager();
    const seen: string[] = [];
    input.onDown((x, y) => seen.push(`down ${x},${y}`));
    input.onUp((x, y) => seen.push(`up ${x},${y}`));
    // Identity transform, so what reaches the InputManager is exactly the canvas-local point.
    new WebAdapter(canvas, input, (sx, sy) => ({ x: sx, y: sy }));
    return { canvas, seen };
  }

  it('passes coordinates through unchanged when the canvas sits at the viewport origin', () => {
    const { canvas, seen } = setup({ left: 0, top: 0 });
    canvas.dispatchEvent(pointer('pointerdown', 120, 300));
    g.window!.dispatchEvent(pointer('pointerup', 120, 300));
    expect(seen).toEqual(['down 120,300', 'up 120,300']);
  });

  it('maps taps onto the canvas when the page has been scrolled up under it', () => {
    // The keyboard left the document scrolled by 336 px: the canvas's top edge is now above the
    // viewport, and a finger on a button drawn at canvas y=500 reports clientY=164.
    const { canvas, seen } = setup({ left: 0, top: -336 });
    canvas.dispatchEvent(pointer('pointerdown', 120, 164));
    g.window!.dispatchEvent(pointer('pointerup', 120, 164));
    expect(seen).toEqual(['down 120,500', 'up 120,500']);
  });
});
