// cjkPadding: the anti-clip texture padding for CJK glyph tops (client/src/render/pixiText.ts).
// PIXI measures a font's ascent from Latin metrics, so tall 汉字 tops clip at row 0 of the
// text canvas; padding enlarges only the backing texture (layout-neutral) to prevent it.
// (makeText itself constructs a PIXI.Text and needs a canvas, so it is exercised by the
// .ui.ts / running-app path, not this node-env unit test.)
import { describe, it, expect } from 'vitest';
import { cjkPadding } from '../src/render/pixiText';

describe('cjkPadding', () => {
  it('scales ~15% of font size, rounded up', () => {
    expect(cjkPadding(22)).toBe(4);
    expect(cjkPadding(48)).toBe(8);
    expect(cjkPadding(10)).toBe(2);
  });

  it('is always positive so a glyph top can never sit flush at the canvas edge', () => {
    for (const size of [8, 12, 16, 24, 32, 64]) expect(cjkPadding(size)).toBeGreaterThan(0);
  });

  it('falls back to a sane default for a non-numeric size', () => {
    expect(cjkPadding(NaN)).toBe(cjkPadding(16));
    expect(cjkPadding(0)).toBe(cjkPadding(16));
  });
});
