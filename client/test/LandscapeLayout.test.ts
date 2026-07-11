import { describe, it, expect } from 'vitest';
import { LandscapeLayout } from '../src/layout/LandscapeLayout';
import { createLayout } from '../src/layout/ScalingManager';

// The landscape design height is fixed at 1080; the width follows the *safe
// drawable area* aspect (never below the classic 1920) so fit-to-height scaling
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

  it('anchors the HUD strips to the edges and stretches the hand on a wide phone', () => {
    const l = new LandscapeLayout(844, 390);
    // Top HUD spans the full (widened) width.
    expect(l.hudTopRect.x).toBe(0);
    expect(l.hudTopRect.w).toBe(l.designWidth);
    // Bottom-left strip stays flush left; bottom-right strip stays flush right.
    expect(l.hudBottomLeftRect.x).toBe(0);
    expect(l.hudBottomRightRect.x + l.hudBottomRightRect.w).toBe(l.designWidth);
    // Hand fills the reclaimed middle between the two bottom strips.
    expect(l.handRect.x).toBe(l.hudBottomLeftRect.w);
    expect(l.handRect.x + l.handRect.w).toBe(l.hudBottomRightRect.x);
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

  it('round-trips grid ↔ screen coordinates through the shifted board origin', () => {
    const l = new LandscapeLayout(844, 390);
    for (const [col, row] of [[0, 0], [5, 9], [11, 17]] as const) {
      const p = l.gridToScreen(col, row);
      expect(l.screenToCol(p.x, p.y)).toBe(col);
      expect(l.screenToRow(p.x, p.y)).toBe(row);
    }
  });
});
