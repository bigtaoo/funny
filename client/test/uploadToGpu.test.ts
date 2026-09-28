/**
 * uploadToGpu.test.ts — the GPU pre-upload helper the world-atlas prefetch wave uses (ADR-099).
 */
import { describe, it, expect, afterEach } from 'vitest';
import type * as PIXI from 'pixi.js-legacy';
import { setBakeRenderer, uploadToGpu } from '../src/render/bake';

afterEach(() => setBakeRenderer(null as unknown as PIXI.IRenderer));

const tex = (valid: boolean) => ({ valid }) as unknown as PIXI.BaseTexture;

describe('uploadToGpu', () => {
  it('binds a decoded texture through the renderer\'s texture system, which is what uploads it', () => {
    const bound: unknown[] = [];
    setBakeRenderer({ resolution: 1, texture: { bind: (t: unknown) => bound.push(t) } } as unknown as PIXI.IRenderer);
    const t = tex(true);
    expect(uploadToGpu(t)).toBe(true);
    expect(bound).toEqual([t]);
  });

  it('does nothing for a texture that has not decoded', () => {
    const bound: unknown[] = [];
    setBakeRenderer({ resolution: 1, texture: { bind: (t: unknown) => bound.push(t) } } as unknown as PIXI.IRenderer);
    expect(uploadToGpu(tex(false))).toBe(false);
    expect(bound).toEqual([]);
  });

  it('is a no-op without a renderer, and on the canvas fallback (no texture system)', () => {
    expect(uploadToGpu(tex(true))).toBe(false);
    setBakeRenderer({ resolution: 1 } as unknown as PIXI.IRenderer);
    expect(uploadToGpu(tex(true))).toBe(false);
  });
});
