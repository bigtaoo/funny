import { describe, it, expect } from 'vitest';
import { LandscapeLayout } from '../src/layout/LandscapeLayout';
import { createLayout } from '../src/layout/ScalingManager';
import { Side } from '../src/game';

// The landscape design height is 1080 on screens >= ~670 CSS px tall and 640–1078 below that
// (ADR-105 + its 2026-10-07 landscape section, designSize.ts: target 0.62x, floor 640); the width
// follows the *safe
// drawable area* aspect (never below the classic 1920, and since 2026-08-25 never
// above 2592 = 2.4:1, both scaled by designHeight/1080) so fit-to-height scaling
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
    // Height 390 / 0.62 = 629, floored at 640; width matches the screen aspect: 640 * 844/390.
    expect(l.designHeight).toBe(640);
    expect(l.designWidth).toBe(Math.round(640 * 844 / 390));
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
    // Height floors at 640 (270 / 0.62 = 435 is below it), so the cap is 2592 * 640/1080 = 1536.
    expect(l.designHeight).toBe(640);
    expect(l.designWidth).toBe(1536);
    // Past the cap it contains to height, so side bands appear — which is exactly what
    // ScalingManager's desk surround is for (it already does this on every iPad).
    const scale = Math.min(750 / l.designWidth, 270 / l.designHeight);
    expect(scale).toBe(270 / l.designHeight);
    expect(750 - l.designWidth * scale).toBeGreaterThan(2);
    // The board still fits with room for both HUD columns (boardX >= 330k for every allowed width).
    expect(l.boardRect.x).toBeGreaterThanOrEqual(Math.floor(330 * 640 / 1080));
    expect(l.hudBottomLeftRect.x).toBeGreaterThanOrEqual(0);
  });

  it('leaves every real phone aspect below the cap', () => {
    // 16:9 through 21:9 (the widest shipping phone aspect) must still fill the width with no bands.
    for (const [w, h] of [[1920, 1080], [844, 390], [2340, 1080], [2520, 1080]] as const) {
      const l = new LandscapeLayout(w, h);
      expect(l.designWidth).toBeLessThan(Math.round(2592 * l.designHeight / 1080));
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
    expect(l.designWidth).toBe(Math.round(640 * 844 / 390));
  });

  it('shrinks the design area for safe-area insets via createLayout', () => {
    // Landscape insets (e.g. notch on the left, home indicator at the bottom)
    // reduce the drawable area, so the design width tracks the *safe* aspect.
    // On a viewport above the 640 floor, so the inset moves the height too (844x390 sits on it).
    const noInset = createLayout(1100, 574);
    const inset   = createLayout(1100, 574, undefined, { top: 0, right: 0, bottom: 21, left: 47 });
    // (1100 − 47) × (574 − 21) → height 553 / 0.62 = 892, and a narrower design width than no-inset.
    expect(inset.designHeight).toBe(892);
    expect(inset.designWidth).toBe(Math.round(892 * (1100 - 47) / (574 - 21)));
    expect(inset.designWidth).toBeLessThan(noInset.designWidth);
  });

  it('keeps the classic 1080-tall geometry on screens at least ~670 CSS px tall', () => {
    for (const [w, h] of [[1024, 768], [1280, 720], [1366, 768], [1920, 1080], [1192, 670]] as const) {
      const l = new LandscapeLayout(w, h);
      expect(l.designHeight).toBe(1080);
      expect(l.cellSize).toBe(70);
      expect(l.boardRect.y).toBe(60);
      expect(l.handRect.h).toBe(180);
    }
  });

  it('renders the CrazyGames canvases at the landscape target scale (2026-10-07)', () => {
    // The reviewer's in-portal frame and the portal's preview tile: both used to sit at 0.50-0.53x.
    for (const [w, h, dh] of [[1100, 574, 926], [722, 406, 654]] as const) {
      const l = new LandscapeLayout(w, h);
      expect(l.designHeight).toBe(dh);
      expect(Math.min(w / l.designWidth, h / l.designHeight)).toBeCloseTo(0.62, 2);
    }
  });

  it('scales the battle geometry with the design height and stacks the bands exactly', () => {
    for (const [w, h] of [[844, 390], [640, 360], [915, 412], [740, 360], [568, 320], [1100, 574], [722, 406], [1190, 668]] as const) {
      const l = new LandscapeLayout(w, h);
      const k = l.designHeight / 1080;
      expect(l.designHeight).toBeGreaterThanOrEqual(640);
      expect(l.designHeight).toBeLessThan(1080);
      expect(l.cellSize).toBe(Math.floor(70 * k));
      // Top HUD + board + bottom strip = the design height, to the pixel (auditBox predicts it).
      expect(l.hudTopRect.h + l.boardRect.h + l.handRect.h).toBe(l.designHeight);
      expect(l.handRect.y).toBe(l.boardRect.y + l.boardRect.h);
      // The side columns still fit in the margins beside the board.
      expect(l.hudBottomLeftRect.x).toBeGreaterThanOrEqual(0);
      expect(l.hudBottomRightRect.x + l.hudBottomRightRect.w).toBeLessThanOrEqual(l.designWidth);
      // The screen scale is now ~0.5 rather than ~0.36 (the whole point).
      expect(Math.min(w / l.designWidth, h / l.designHeight)).toBeGreaterThan(0.43);
    }
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
    const center = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    for (const [w, h] of [[1920, 1080], [844, 390]] as const) {
      const l = new LandscapeLayout(w, h, side);
      expect(center(l.playerBaseRect())).toEqual(l.gridToScreen(5.5, ownRow));
      expect(center(l.enemyBaseRect())).toEqual(l.gridToScreen(5.5, enemyRow));
    }
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
