// The font scale's legibility floor (render/fontScale.ts): pins the arithmetic that turns a
// design→screen scale into "the smallest size a label may render at", because that number is
// asserted independently by the portrait sweep's `tiny` gate
// (test/browser/portraitLayout.spec.ts) and the two must not drift.
//
// Why a floor exists at all: portrait's design width is a fixed 1080, so the whole UI renders at
// 0.36x on a 390-wide phone and `FS.micro`'s 11 design px land as 4 CSS px. See the fontScale.ts
// header and design/game/UI_DESIGN_LOG_2026-08.md §49.
import { describe, it, expect, afterEach } from 'vitest';
import {
  FS, MIN_LEGIBLE_CSS_PX, fontFloorDesignPx, setFontScale, resetFontScaleForTest, currentFontFloor,
  snapFont, fitFont,
} from '../../src/render/fontScale';

/** `PortraitLayout`'s own sizing, duplicated so this test states the scale it is talking about. */
function portraitScale(cssW: number, cssH: number): number {
  const designH = Math.max(1920, Math.round(1080 * (cssH / cssW)));
  return Math.min(cssW / 1080, cssH / designH);
}

afterEach(() => resetFontScaleForTest());

describe('font legibility floor', () => {
  it('leaves a desktop landscape window on the raw table', () => {
    // 1600x900 landscape: designHeight 1080, so 0.83x — micro is already 9 CSS px there.
    setFontScale(900 / 1080);
    expect(currentFontFloor()).toBe(11);
    expect(FS.micro).toBe(11);
    expect(FS.body).toBe(18);
  });

  it('lifts the bottom of the scale on a phone held upright', () => {
    const scale = portraitScale(390, 844);
    expect(scale).toBeCloseTo(0.361, 3);
    setFontScale(scale);
    // 7 / 0.361 = 19.4 design px, snapped up the table to bodyLg.
    expect(currentFontFloor()).toBe(20);
    expect(FS.micro).toBe(20);
    expect(FS.tiny).toBe(20);
    expect(FS.small).toBe(20);
    expect(FS.body).toBe(20);
    // Above the floor nothing moves — the floor is a floor, not a rescale.
    expect(FS.label).toBe(24);
    expect(FS.display).toBe(60);
  });

  it('caps the floor instead of climbing past a label on the narrowest phone', () => {
    const scale = portraitScale(360, 640);
    setFontScale(scale);
    // 7 / 0.333 = 21 design px would snap to `label` (24); the cap holds it at bodyLg, which is
    // the deliberate shortfall documented in fontScale.ts (6.7 CSS px, not 7).
    expect(currentFontFloor()).toBe(20);
    expect(FS.micro * scale).toBeLessThan(MIN_LEGIBLE_CSS_PX);
    expect(FS.micro * scale).toBeGreaterThan(6.5);
  });

  it('lifts a tablet less, because it renders bigger', () => {
    const scale = portraitScale(768, 1024);
    expect(scale).toBeCloseTo(0.533, 3);
    setFontScale(scale);
    // 7 / 0.533 = 13.1 → `small`. micro/tiny lift, everything else is already legible.
    expect(currentFontFloor()).toBe(16);
    expect(FS.micro).toBe(16);
    expect(FS.small).toBe(16);
    expect(FS.body).toBe(18);
  });

  it('never returns a floor off the token table', () => {
    const tokens = new Set(Object.values(FS));
    for (const scale of [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 1, 2]) {
      expect(tokens.has(fontFloorDesignPx(scale))).toBe(true);
    }
  });

  it('treats a degenerate scale as no floor at all', () => {
    // `createLayout(0, 0)` is reachable on a cold boot with no layout yet — see bake.ts's
    // resolution floor, which exists for the same window.
    for (const bad of [0, -1, NaN, Infinity]) expect(fontFloorDesignPx(bad)).toBe(11);
  });

  describe('fitFont — the alternative to scaling a built group', () => {
    it('leaves a size that already fits alone', () => {
      setFontScale(portraitScale(390, 844));
      expect(fitFont(FS.label, 100, 120)).toBe(FS.label);
      expect(fitFont(FS.label, 120, 120)).toBe(FS.label);
    });

    it('steps DOWN the table to the size that fits', () => {
      resetFontScaleForTest();
      // Monospace width is linear in size, so 24px needing 300 in 200 wants 16 — a real token.
      expect(fitFont(24, 300, 200)).toBe(16);
      // ...and lands on the token BELOW the exact fit rather than rounding up past the box.
      expect(fitFont(24, 310, 200)).toBe(13);
    });

    it('never goes below the floor, even when that still does not fit', () => {
      setFontScale(portraitScale(390, 844));   // floor 20
      expect(fitFont(24, 300, 200)).toBe(20);
      expect(fitFont(24, 3000, 20)).toBe(20);
    });

    it('is inert on a degenerate measurement', () => {
      resetFontScaleForTest();
      expect(fitFont(24, 0, 100)).toBe(24);
      expect(fitFont(24, NaN, 100)).toBe(24);
      expect(fitFont(24, 300, NaN)).toBe(24);
    });
  });

  it('carries the floor through snapFont', () => {
    setFontScale(portraitScale(390, 844));
    // A control whose height suggests 9px text still gets readable text.
    expect(snapFont(9)).toBe(20);
    // ...and a genuinely large computed size is untouched.
    expect(snapFont(41)).toBe(42);
  });
});
