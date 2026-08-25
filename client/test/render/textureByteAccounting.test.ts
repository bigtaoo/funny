/**
 * textureByteAccounting.test.ts — MemoryMonitor's texture accounting must be in BYTES.
 *
 * Why this test exists: on 2026-08-25 a phone-class in-app WebView was killed on a reload loop by
 * three page-sized RenderTextures of 111 MB each. Every gate the client had missed it —
 * `genTexCount()` saw **3** against a budget of 600, and `usedJSHeapSize` barely moved because the
 * bytes are GPU-side. "Few but enormous" is not expressible as a count, so the count gate cannot be
 * the only gate; these cases pin the byte arithmetic and the "name the biggest one" output that
 * would have made that report readable at a glance.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { baseTextureCache } = vi.hoisted(() => ({
  baseTextureCache: {} as Record<string, { realWidth: number; realHeight: number }>,
}));

vi.mock('pixi.js-legacy', () => ({
  utils: { BaseTextureCache: baseTextureCache, TextureCache: {} },
  // MemoryMonitor and render/bake only reach for these at call time, never at module scope.
  RenderTexture: { create: () => ({ baseTexture: { realWidth: 0, realHeight: 0 } }) },
  Container: class { destroy(): void { /* noop */ } },
  Ticker: class {},
}));

import { texBytes } from '../../src/cache/MemoryMonitor';

/** Register a fake base texture under `key` at a given REAL (device) pixel size. */
function put(key: string, realWidth: number, realHeight: number): void {
  baseTextureCache[key] = { realWidth, realHeight };
}

const MB = 1024 * 1024;

beforeEach(() => {
  for (const k of Object.keys(baseTextureCache)) delete baseTextureCache[k];
});

describe('texBytes', () => {
  it('is zero-ish on an empty cache rather than null', () => {
    expect(texBytes()).toEqual({ totalMB: 0, generatedMB: 0, largestMB: 0, largest: '' });
  });

  it('sums RGBA bytes from real pixels, so a texture resolution is already included', () => {
    // realWidth/realHeight are post-resolution — which is exactly the factor that was wrong in the
    // crash, so the accounting has to read them rather than the logical width/height.
    put('assets/units/archer.png', 673, 693);
    const s = texBytes()!;
    expect(s.totalMB).toBeCloseTo((673 * 693 * 4) / MB, 1);
  });

  it('splits generated textures out from URL-keyed assets', () => {
    // PIXI keys generated textures by uid (no slash); assets by their webpack URL. The generated
    // class is the one freed only by an explicit destroy, so it is worth its own number.
    put('assets/icons/icons_atlas.png', 2048, 768);
    put('pixiid_25', 1000, 1000);
    put('pixiid_26', 500, 500);
    const s = texBytes()!;
    expect(s.generatedMB).toBeCloseTo(((1000 * 1000) + (500 * 500)) * 4 / MB, 1);
    expect(s.totalMB).toBeGreaterThan(s.generatedMB);
  });

  it('names the single biggest texture — the line that makes "few but enormous" visible', () => {
    // The pre-fix lobby, as it actually was: three of these and a count of 3.
    put('pixiid_1', 9000, 3240);
    for (let i = 0; i < 40; i++) put(`assets/avatars/preset/p${i}.png`, 512, 769);
    const s = texBytes()!;
    expect(s.largest).toBe('pixiid_1 9000x3240');
    expect(s.largestMB).toBeCloseTo(9000 * 3240 * 4 / MB, 0);
    // A count-based gate would rank the 40 avatars as the problem; bytes rank the one texture.
    expect(s.largestMB).toBeGreaterThan(s.totalMB - s.largestMB);
  });

  it('reports an asset bucket (not the full URL) for the biggest asset texture', () => {
    put('assets/slg/world_atlas.png', 1960, 1827);
    expect(texBytes()!.largest).toBe('assets/slg 1960x1827');
  });

  it('skips entries with no usable size instead of counting them as zero-area garbage', () => {
    put('assets/broken.png', 0, 0);
    put('assets/ok.png', 1000, 1000);
    const s = texBytes()!;
    expect(s.totalMB).toBeCloseTo(1000 * 1000 * 4 / MB, 1);
    // The zero-area entry must not win `largest` by being the last one seen.
    expect(s.largest).toBe('assets 1000x1000');
  });
});
