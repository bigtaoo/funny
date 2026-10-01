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
  snapFont, snapFontDown, fitFont, iconFloorPx, fontBoost, currentFontBoost, MAX_BOOST, TARGET_BODY_CSS_PX,
} from '../../src/render/fontScale';
import { portraitDesignWidth } from '../../src/layout/designSize';

/** `PortraitLayout`'s own sizing (width from layout/designSize.ts), so this test states its scale. */
function portraitScale(cssW: number, cssH: number): number {
  const designW = portraitDesignWidth(cssW);
  const designH = Math.max(Math.round(1920 * designW / 1080), Math.round(designW * (cssH / cssW)));
  return Math.min(cssW / designW, cssH / designH);
}

afterEach(() => resetFontScaleForTest());

/**
 * A phone held sideways (844x390: design height 1080 → 0.361). Until 2026-10-01 this was also the
 * upright phone's scale, and most of the arithmetic below was written against it; upright phones
 * now get a narrower design (layout/designSize.ts) at ~0.5, covered by its own case.
 */
const SIDEWAYS_390 = 390 / 1080;
/** 640x360 held sideways — 0.333, the smallest scale any shipped layout produces. */
const SIDEWAYS_360 = 360 / 1080;

describe('font legibility floor', () => {
  it('leaves a desktop landscape window on the raw table', () => {
    // 1600x900 landscape: designHeight 1080, so 0.83x — micro is already 9 CSS px there.
    setFontScale(900 / 1080);
    expect(currentFontFloor()).toBe(11);
    expect(FS.micro).toBe(11);
    expect(FS.body).toBe(18);
  });

  it('lifts the bottom of the scale on a phone held sideways', () => {
    const scale = SIDEWAYS_390;
    expect(scale).toBeCloseTo(0.361, 3);
    setFontScale(scale);
    // 7 / 0.361 = 19.4 design px, snapped up the table to bodyLg.
    expect(currentFontFloor()).toBe(20);
    // The boost (1.4x, its cap) takes micro to 15 and tiny to 18 — still under the floor, so
    // those two land on it; everything from small up is boosted clear of it.
    expect(currentFontBoost()).toBe(MAX_BOOST);
    expect(FS.micro).toBe(20);
    expect(FS.tiny).toBe(20);
    expect(FS.small).toBe(22);
    expect(FS.body).toBe(25);
  });

  it('caps the floor instead of climbing past a label on the narrowest phone', () => {
    const scale = SIDEWAYS_360;
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

  // The phone type boost (2026-10-01, design log UI_DESIGN_LOG_2026-10.md §72): the floor alone
  // left body at 7.2 CSS px on a phone, and could not climb higher without collapsing the scale.
  describe('phone type boost', () => {
    it('is exactly 1 on a desktop window and on a tablet', () => {
      for (const scale of [900 / 1080, 0.711, portraitScale(768, 1024)]) {
        setFontScale(scale);
        expect(currentFontBoost()).toBe(1);
        expect(FS.body).toBe(18);
        expect(FS.display).toBe(60);
      }
    });

    it('needs less of itself on an upright phone, whose design narrowed to a 0.5 scale', () => {
      // 390x844 upright: 780-wide design (layout/designSize.ts) → 0.5, so body only needs 1.1x to
      // reach TARGET_BODY_CSS_PX; held sideways the same phone is still 0.361 and at the cap.
      expect(portraitScale(390, 844)).toBeCloseTo(0.5, 3);
      expect(fontBoost(portraitScale(390, 844))).toBe(1.1);
      expect(fontBoost(SIDEWAYS_390)).toBe(MAX_BOOST);
      setFontScale(portraitScale(390, 844));
      expect(FS.body * portraitScale(390, 844)).toBeGreaterThanOrEqual(TARGET_BODY_CSS_PX - 0.5);
    });

    it('asks for body at TARGET_BODY_CSS_PX and is capped below it on a phone', () => {
      const scale = SIDEWAYS_390;
      setFontScale(scale);
      expect(FS.body * scale).toBeGreaterThan(8.9);
      expect(FS.body * scale).toBeLessThan(TARGET_BODY_CSS_PX);
    });

    it('keeps every token strictly above the one below it from small upward', () => {
      // micro/tiny share the floor (as before the boost); the boost must never collapse more.
      for (const scale of [0.3, 0.333, 0.361, 0.4, 0.42, 0.45, 0.5]) {
        setFontScale(scale);
        const seq = [FS.small, FS.body, FS.bodyLg, FS.label, FS.heading, FS.title, FS.headline, FS.display];
        for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThan(seq[i - 1]!);
      }
    });

    it('tapers towards display, which needs it least', () => {
      setFontScale(SIDEWAYS_390);
      expect(FS.body / 18).toBeGreaterThan(FS.display / 60);
      expect(FS.title / 32).toBeGreaterThan(FS.display / 60);
    });

    it('is quantised, so a few px of window drag does not mint new sizes', () => {
      expect(fontBoost(0.40)).toBe(fontBoost(0.401));
      expect((fontBoost(0.42) * 20) % 1).toBeCloseTo(0, 9);
    });

    it('treats a degenerate scale as no boost', () => {
      for (const bad of [0, -1, NaN, Infinity]) expect(fontBoost(bad)).toBe(1);
    });

    it('leaves snapFont on the raw ladder — a control does not grow, so its text may not', () => {
      setFontScale(SIDEWAYS_390);
      expect(snapFont(41)).toBe(42);
      expect(snapFont(24)).toBe(24);
    });
  });

  describe('fitFont — the alternative to scaling a built group', () => {
    it('leaves a size that already fits alone', () => {
      setFontScale(SIDEWAYS_390);
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
      setFontScale(SIDEWAYS_390);   // floor 20
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
    setFontScale(SIDEWAYS_390);
    // A control whose height suggests 9px text still gets readable text.
    expect(snapFont(9)).toBe(20);
    // ...and a genuinely large computed size is untouched.
    expect(snapFont(41)).toBe(42);
  });

  // The icon counterpart (2026-09-14, design log §52): an icon whose size is a proportion of the
  // control it sits in needs the same floor a proportional FONT size gets, because it fails the
  // same way on the same viewport. The audit's `icon` gate holds icons to exactly this number.
  describe('iconFloorPx', () => {
    it('lifts a proportional icon size to the floor on a phone', () => {
      setFontScale(SIDEWAYS_390);   // floor 20
      // The two sizes the sweep actually reported: achievements' 19, and the lock badge's 18.
      expect(iconFloorPx(19)).toBe(20);
      expect(iconFloorPx(18)).toBe(20);
    });

    it('does NOT snap to the font ladder - only floors, and rounds', () => {
      setFontScale(SIDEWAYS_390);
      // 26 is between `label` (24) and `heading` (28); snapFont would move it, this must not.
      expect(iconFloorPx(26)).toBe(26);
      expect(iconFloorPx(26.4)).toBe(26);
    });

    it('is a no-op on a desktop landscape window', () => {
      setFontScale(900 / 1080);   // floor 11
      expect(iconFloorPx(19)).toBe(19);
      expect(iconFloorPx(18)).toBe(18);
    });
  });
});

describe('snapFont ceiling on a narrow portrait design (2026-10-01)', () => {
  afterEach(() => resetFontScaleForTest());

  it('keeps display as the ceiling wherever the short side is 1080', () => {
    setFontScale(0.711, 1080);
    expect(snapFont(200)).toBe(60);
    setFontScale(0.361, 1080); // a landscape phone
    expect(snapFont(200)).toBe(60);
  });

  it('caps a 720-860 portrait design at 42, the old ~21 CSS px on a phone', () => {
    for (const short of [720, 780, 860]) {
      setFontScale(0.5, short);
      expect(snapFont(200)).toBe(42);
      expect(snapFont(66)).toBe(42);
      expect(snapFontDown(200)).toBe(42);
      // Below the ceiling nothing moves.
      expect(snapFont(33)).toBe(32);
    }
  });
});
