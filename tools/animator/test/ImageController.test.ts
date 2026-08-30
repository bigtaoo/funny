// buildAlphaMask — the decode step behind alpha-aware sprite picking (see
// InteractionController.findSpriteAt). Runs in plain Node: the editor has no headless
// PIXI/DOM harness, so `createImageBitmap` and `document` are stubbed with minimal fakes
// via vi.stubGlobal (same idiom as fileIO.test.ts) and the REAL function body is driven
// against them — the assertions are about what it computes from a raster, not about which
// canvas methods it happens to call.
//
// The class around it (ImageController) is not exercised here: every one of its other
// methods goes through PIXI texture creation, which is exactly the surface this package
// deliberately has no harness for.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildAlphaMask, ALPHA_MASK_MAX } from '../src/images/ImageController';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub the decode → canvas → getImageData path. `rgbaFor` builds the pixel data the fake
 *  2D context hands back, so a test can assert how RGBA is folded down to one alpha byte. */
function stubRaster(
  bitmap: { width: number; height: number },
  rgbaFor: (w: number, h: number) => Uint8ClampedArray = (w, h) => new Uint8ClampedArray(w * h * 4),
  overrides: { getContext?: () => unknown; getImageData?: () => never } = {},
) {
  const drawnSizes: Array<[number, number]> = [];
  const canvasSizes: Array<[number, number]> = [];
  let closeCount = 0;

  const ctx = {
    drawImage: (_bmp: unknown, _x: number, _y: number, w: number, h: number) => { drawnSizes.push([w, h]); },
    getImageData: overrides.getImageData ?? ((_x: number, _y: number, w: number, h: number) => ({ data: rgbaFor(w, h) })),
  };
  const canvas = {
    width: 0, height: 0,
    getContext: overrides.getContext ?? (() => ctx),
  };

  vi.stubGlobal('createImageBitmap', async () => ({
    width: bitmap.width, height: bitmap.height,
    close: () => { closeCount++; },
  }));
  vi.stubGlobal('document', {
    createElement: () => {
      // Record the size the caller sets, at the moment it reads it back.
      return new Proxy(canvas, {
        set(target, prop, value) {
          (target as Record<string, unknown>)[prop as string] = value;
          if (prop === 'height') canvasSizes.push([canvas.width, canvas.height]);
          return true;
        },
      });
    },
  });

  return { drawnSizes, canvasSizes, closed: () => closeCount };
}

const BLOB = new Blob(['not actually read — createImageBitmap is stubbed']);

describe('buildAlphaMask', () => {
  it('keeps a small image at its native size', async () => {
    stubRaster({ width: 40, height: 100 });
    const mask = await buildAlphaMask(BLOB);
    expect(mask).not.toBeNull();
    expect([mask!.w, mask!.h]).toEqual([40, 100]);
    expect(mask!.data.length).toBe(40 * 100);
  });

  it('folds RGBA down to the alpha byte, row-major', async () => {
    // 2x2, alpha = 10*index so every pixel is distinguishable from its neighbours.
    stubRaster({ width: 2, height: 2 }, (w, h) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        d[i * 4]     = 255;      // R/G/B deliberately non-zero: only alpha may survive
        d[i * 4 + 1] = 128;
        d[i * 4 + 2] = 64;
        d[i * 4 + 3] = i * 10;
      }
      return d;
    });
    const mask = await buildAlphaMask(BLOB);
    expect(Array.from(mask!.data)).toEqual([0, 10, 20, 30]);
  });

  it('downsamples a large image so its longest side lands on the cap', async () => {
    const { drawnSizes, canvasSizes } = stubRaster({ width: ALPHA_MASK_MAX * 4, height: ALPHA_MASK_MAX * 2 });
    const mask = await buildAlphaMask(BLOB);
    expect([mask!.w, mask!.h]).toEqual([ALPHA_MASK_MAX, ALPHA_MASK_MAX / 2]);   // aspect ratio preserved
    expect(mask!.data.length).toBe(ALPHA_MASK_MAX * (ALPHA_MASK_MAX / 2));
    // The raster really was drawn (and the canvas sized) at the reduced size — a mask that
    // reported a small w/h while rasterising at full size would cost the memory anyway.
    expect(drawnSizes).toEqual([[ALPHA_MASK_MAX, ALPHA_MASK_MAX / 2]]);
    expect(canvasSizes).toEqual([[ALPHA_MASK_MAX, ALPHA_MASK_MAX / 2]]);
  });

  it('leaves an image exactly at the cap alone (never upscales)', async () => {
    stubRaster({ width: ALPHA_MASK_MAX, height: 10 });
    const mask = await buildAlphaMask(BLOB);
    expect([mask!.w, mask!.h]).toEqual([ALPHA_MASK_MAX, 10]);
  });

  it('never rounds a sliver of an image down to a zero-size mask', async () => {
    // 4000x3: the scale factor rounds height to 0, which would make getImageData throw and
    // every hit-test against this slot read as transparent.
    stubRaster({ width: 4000, height: 3 });
    const mask = await buildAlphaMask(BLOB);
    expect(mask!.h).toBeGreaterThanOrEqual(1);
    expect(mask!.data.length).toBe(mask!.w * mask!.h);
  });

  it('releases the decoded bitmap on the success path', async () => {
    const { closed } = stubRaster({ width: 8, height: 8 });
    await buildAlphaMask(BLOB);
    expect(closed()).toBe(1);
  });

  it('returns null — and releases the bitmap — when no 2D context is available', async () => {
    const { closed } = stubRaster({ width: 8, height: 8 }, undefined, { getContext: () => null });
    expect(await buildAlphaMask(BLOB)).toBeNull();
    expect(closed()).toBe(1);
  });

  it('returns null for a blob that cannot be decoded', async () => {
    vi.stubGlobal('createImageBitmap', async () => { throw new Error('unsupported image type'); });
    expect(await buildAlphaMask(BLOB)).toBeNull();
  });

  it('returns null rather than throwing when rasterising fails mid-way', async () => {
    // A throw here (tainted canvas, out-of-memory) must not propagate: setBlob awaits this
    // call, so an escaping error would break loading the image itself, not just its mask.
    stubRaster({ width: 8, height: 8 }, undefined, {
      getImageData: (() => { throw new Error('SecurityError'); }) as () => never,
    });
    expect(await buildAlphaMask(BLOB)).toBeNull();
  });

  it('returns null in an environment with no createImageBitmap at all', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    expect(await buildAlphaMask(BLOB)).toBeNull();
  });
});
