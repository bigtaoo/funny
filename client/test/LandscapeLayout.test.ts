import { describe, it, expect } from 'vitest';
import { LandscapeLayout } from '../src/layout/LandscapeLayout';
import { createLayout } from '../src/layout/ScalingManager';
import { Side } from '../src/game';

// The landscape design height is fixed at 1080; the width follows the *safe
// drawable area* aspect (never below the classic 1920, and since 2026-08-25 never
// above 2592 = 2.4:1) so fit-to-height scaling
// leaves no side letterbox on tall phones held sideways. Safe-area insets are
// applied upstream in createLayout (which shrinks the area) and by ScalingManager
// (which offsets the layer). Mirror of PortraitLayout.test.ts.

describe('LandscapeLayout dynamic width', () => {
  it('keeps the classic 1920 width and centered board at a 16:9 aspect', () => {
    // 1920×1080 aspect. Any screen at this aspect → reference layout.
    const l = new LandscapeLayout(1920, 1080);
    expect(l.designWidth).toBe(1920);
    // Board is horizontally centered: (1920 - 1260) / 2 = 330.
    expect(l.boardRect.x).toBe(330);
    expect(l.boardRect.y).toBe(60);
  });

  it('clamps to 1920 when the screen is taller than 16:9', () => {
    // 1280×800 (1.6, narrower than 16:9) — aspectW < 1920 → clamped.
    const l = new LandscapeLayout(1280, 800);
    expect(l.designWidth).toBe(1920);
    expect(l.boardRect.x).toBe(330);
  });

  it('grows the design width on a tall phone held sideways so there is no letterbox', () => {
    // iPhone 13 landscape logical viewport: 844×390 (~19.5:9).
    const l = new LandscapeLayout(844, 390);
    // designWidth must match the screen aspect: 1080 * 844/390 ≈ 2337.
    expect(l.designWidth).toBe(Math.round(1080 * 844 / 390));
    // Fit-to-height scale (screenH/designHeight) === fit-to-width scale → no letterbox.
    const scaleW = 844 / l.designWidth;
    const scaleH = 390 / l.designHeight;
    expect(Math.abs(scaleW - scaleH)).toBeLessThan(0.001);
  });

  it('stops widening past 2.4:1 and lets the desk surround take the bands', () => {
    // 750x270 CSS px: the iPhone 13 in-app WebView behind the 2026-08-25 crash loop — 2.78:1,
    // because the notch safe area took 94px off the width and the host app's bars 120px off the
    // height. Uncapped that asked for a 3000-wide design rect: 56% more empty paper flanking a
    // 1260-wide board, and 56% more pixels in every page-sized texture (see render/bake.ts).
    const l = new LandscapeLayout(750, 270);
    expect(l.designWidth).toBe(2592);
    // Past the cap it contains to height, so side bands appear — which is exactly what
    // ScalingManager's desk surround is for (it already does this on every iPad).
    const scale = Math.min(750 / l.designWidth, 270 / l.designHeight);
    expect(scale).toBe(270 / l.designHeight);
    expect(750 - l.designWidth * scale).toBeGreaterThan(2);
    // The board still fits with room for both HUD columns (boardX >= 330 for every allowed width).
    expect(l.boardRect.x).toBeGreaterThanOrEqual(330);
    expect(l.hudBottomLeftRect.x).toBeGreaterThanOrEqual(0);
  });

  it('leaves every real phone aspect below the cap', () => {
    // 16:9 through 21:9 (the widest shipping phone aspect) must still fill the width with no bands.
    for (const [w, h] of [[1920, 1080], [844, 390], [2340, 1080], [2520, 1080]] as const) {
      const l = new LandscapeLayout(w, h);
      expect(l.designWidth).toBeLessThan(2592);
      const scaleW = w / l.designWidth;
      const scaleH = h / l.designHeight;
      expect(Math.abs(scaleW - scaleH)).toBeLessThan(0.001);
    }
  });

  it('anchors the HUD strips to the board and fills the hand to the board width', () => {
    const l = new LandscapeLayout(844, 390);
    const boardLeft  = l.boardRect.x;
    const boardRight = l.boardRect.x + l.boardRect.w;
    // Top HUD spans the full (widened) width.
    expect(l.hudTopRect.x).toBe(0);
    expect(l.hudTopRect.w).toBe(l.designWidth);
    // The ink/HP column sits in the LEFT margin, its inner edge flush against the
    // board's left edge; the refresh/upgrade column sits in the RIGHT margin, its
    // inner edge flush against the board's right edge. Both stay locked to the
    // board no matter how wide the design space grows.
    expect(l.hudBottomLeftRect.x + l.hudBottomLeftRect.w).toBe(boardLeft);
    expect(l.hudBottomRightRect.x).toBe(boardRight);
    // Each side column fits entirely within its margin (never off-screen, never
    // overlapping the board).
    expect(l.hudBottomLeftRect.x).toBeGreaterThanOrEqual(0);
    expect(l.hudBottomRightRect.x + l.hudBottomRightRect.w).toBeLessThanOrEqual(l.designWidth);
    // Hand fills the board's horizontal extent exactly.
    expect(l.handRect.x).toBe(boardLeft);
    expect(l.handRect.x + l.handRect.w).toBe(boardRight);
    // Board stays centered in the widened space.
    expect(l.boardRect.x).toBe(Math.round((l.designWidth - l.boardRect.w) / 2));
  });

  it('routes createLayout to the landscape layout when width > height', () => {
    const l = createLayout(844, 390);
    expect(l.orientation).toBe('landscape');
    expect(l.designWidth).toBe(Math.round(1080 * 844 / 390));
  });

  it('shrinks the design area for safe-area insets via createLayout', () => {
    // Landscape insets (e.g. notch on the left, home indicator at the bottom)
    // reduce the drawable area, so the design width tracks the *safe* aspect.
    const noInset = createLayout(844, 390);
    const inset   = createLayout(844, 390, undefined, { top: 0, right: 0, bottom: 21, left: 47 });
    // (844 − 47) × (390 − 21) → narrower design width than no-inset.
    expect(inset.designWidth).toBe(Math.round(1080 * (844 - 47) / (390 - 21)));
    expect(inset.designWidth).toBeLessThan(noInset.designWidth);
  });

  // Regression: the base *sprite* rect must sit exactly where gridToScreen renders
  // that base's physical center, for BOTH host and joiner. gridToScreen mirrors the
  // board for the joiner (Side.Top), so the sprite rects must mirror to match — else
  // the castle art, upgrade tier, cracks and the under-attack hit outline all land on
  // the WRONG castle (the joiner saw the enemy's damage flash on their own base).
  // Physical base centers: cols 5-6 → 5.5; own rows 0-1 → 0.5 / rows 16-17 → 16.5.
  it.each([
    { side: Side.Bottom, ownRow: 0.5,  enemyRow: 16.5 },
    { side: Side.Top,    ownRow: 16.5, enemyRow: 0.5  },
  ])('anchors base sprite rects to gridToScreen for localSide=$side', ({ side, ownRow, enemyRow }) => {
    const l = new LandscapeLayout(1920, 1080, side);
    const center = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    expect(center(l.playerBaseRect())).toEqual(l.gridToScreen(5.5, ownRow));
    expect(center(l.enemyBaseRect())).toEqual(l.gridToScreen(5.5, enemyRow));
  });

  it('round-trips grid ↔ screen coordinates through the shifted board origin', () => {
    const l = new LandscapeLayout(844, 390);
    for (const [col, row] of [[0, 0], [5, 9], [11, 17]] as const) {
      const p = l.gridToScreen(col, row);
      expect(l.screenToCol(p.x, p.y)).toBe(col);
      expect(l.screenToRow(p.x, p.y)).toBe(row);
    }
  });
});
