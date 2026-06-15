// pixiHeadless — make PIXI construct display objects (Container / Graphics / Text /
// Sprite) in Node, with NO real renderer, WebGL, jsdom or node-canvas native module.
//
// This is the seam that lets us smoke-test scenes: a scene's constructor builds a
// tree of PIXI display objects and reads text widths to lay them out. The only hard
// DOM dependency in that path is PIXI.Text, which needs a 2D canvas context to
// measure glyphs. PIXI v7 routes ALL DOM access through `settings.ADAPTER`, so we
// swap in a stub adapter whose canvas/context are pure-JS no-ops with just enough
// `measureText` / `getImageData` to keep TextMetrics happy (its measureFont scans
// imagedata for pixels !== 255; an all-zero buffer yields a non-zero, finite size
// without crashing or looping — see @pixi/text TextMetrics.measureFont).
//
// We never create a Renderer, so WebGL is never touched and nothing is uploaded to a
// GPU. This is a STARTUP smoke harness, not a pixel/visual-regression harness.
//
// Loaded via vitest setupFiles (vitest.ui.config.ts) before any scene module imports
// PIXI — settings is a singleton, so the patched ADAPTER is shared.

import { settings } from 'pixi.js-legacy';

// PIXI.Ticker (used by BoilingSprite etc.) starts a requestAnimationFrame loop the
// moment a listener is added. Node has no RAF — provide inert stubs so the ticker
// can register without throwing. We never want it to actually drive frames in a
// smoke test, so the callback is never invoked (scenes are stepped manually).
const gg = globalThis as unknown as {
  requestAnimationFrame?: unknown;
  cancelAnimationFrame?: unknown;
};
if (!gg.requestAnimationFrame) gg.requestAnimationFrame = (): number => 0;
if (!gg.cancelAnimationFrame) gg.cancelAnimationFrame = (): void => undefined;

/** A pure-JS 2D context: real-ish measurement, everything else a no-op. */
function createContext2D(): unknown {
  const ctx: Record<string, unknown> = {
    // ── measurement (the only methods that must return real-ish data) ──
    measureText(s: unknown): object {
      const w = String(s).length * 7;
      return {
        width: w,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: w,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        fontBoundingBoxAscent: 8,
        fontBoundingBoxDescent: 2,
      };
    },
    getImageData(_x: number, _y: number, w: number, h: number): object {
      const ww = Math.max(0, w | 0);
      const hh = Math.max(0, h | 0);
      return { data: new Uint8ClampedArray(ww * hh * 4), width: ww, height: hh };
    },
    createImageData(w: number, h: number): object {
      return { data: new Uint8ClampedArray((w | 0) * (h | 0) * 4), width: w | 0, height: h | 0 };
    },
    putImageData(): void { /* no-op */ },
    createLinearGradient(): object { return { addColorStop(): void {} }; },
    createRadialGradient(): object { return { addColorStop(): void {} }; },
    createPattern(): null { return null; },
    getLineDash(): number[] { return []; },

    // ── default property values (so reads before writes are sane) ──
    font: '10px sans-serif',
    fillStyle: '#000',
    strokeStyle: '#000',
    globalAlpha: 1,
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    miterLimit: 10,
    textBaseline: 'alphabetic',
    textAlign: 'start',
    globalCompositeOperation: 'source-over',
    shadowColor: 'rgba(0,0,0,0)',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    // present so TextMetrics.experimentalLetterSpacingSupported === true
    letterSpacing: '0px',
    textLetterSpacing: '0px',
  };

  // Any drawing call we did not enumerate (fillRect, save, restore, drawImage, …)
  // becomes a no-op function; data property reads/writes fall through to the target.
  return new Proxy(ctx, {
    get(target, prop, recv): unknown {
      if (prop in target) return Reflect.get(target, prop, recv);
      return () => undefined;
    },
  });
}

/** A canvas-like object. Must be `instanceof HTMLCanvasElement` so PIXI's
 * CanvasResource.test() accepts it as a texture source (see CanvasResource.test). */
class HeadlessCanvas {
  width: number;
  height: number;
  private _ctx: unknown = null;
  constructor(width = 1, height = 1) {
    this.width = width;
    this.height = height;
  }
  getContext(): unknown {
    if (!this._ctx) this._ctx = createContext2D();
    return this._ctx;
  }
  addEventListener(): void { /* no-op (renderer view only) */ }
  removeEventListener(): void { /* no-op */ }
  getBoundingClientRect(): object {
    return { x: 0, y: 0, top: 0, left: 0, right: this.width, bottom: this.height, width: this.width, height: this.height };
  }
  toDataURL(): string { return ''; }
  get style(): object { return {}; }
}

// CanvasResource.test() does `source instanceof HTMLCanvasElement`; make our class
// answer to that global. Leave OffscreenCanvas undefined so TextMetrics falls back
// to the adapter (and CanvasResource does not false-match our object).
const g = globalThis as unknown as { HTMLCanvasElement?: unknown };
if (!g.HTMLCanvasElement) g.HTMLCanvasElement = HeadlessCanvas;

settings.ADAPTER = {
  createCanvas: (width = 1, height = 1): unknown => new HeadlessCanvas(width, height),
  getCanvasRenderingContext2D: (): unknown => class {},
  getWebGLRenderingContext: (): unknown =>
    (globalThis as unknown as { WebGLRenderingContext?: unknown }).WebGLRenderingContext ?? class {},
  getNavigator: (): { userAgent: string } => ({ userAgent: 'headless' }),
  getBaseUrl: (): string => '',
  getFontFaceSet: (): null => null,
  fetch: (url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    if (typeof globalThis.fetch === 'function') return globalThis.fetch(url, options);
    return Promise.reject(new Error('fetch not available in headless harness'));
  },
  parseXML: (): Document => {
    throw new Error('parseXML not supported in the headless PIXI harness (no bitmap fonts)');
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;
