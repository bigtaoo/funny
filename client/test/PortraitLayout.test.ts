import { describe, it, expect } from 'vitest';
import { PortraitLayout } from '../src/layout/PortraitLayout';
import { createLayout } from '../src/layout/ScalingManager';
import { Side } from '../src/game';

// The portrait design width follows the screen (layout/designSize.ts: 1080 from
// 540 CSS px up, availW/0.5 clamped to 720 below); the height follows the *safe
// drawable area* aspect (never below the classic 1920) so fit-to-width scaling
// leaves no letterbox on tall phones. Safe-area insets are applied upstream in
// createLayout (which shrinks the area) and by ScalingManager (which offsets the
// layer). See src/layout/PortraitLayout.ts + ScalingManager.ts.

describe('PortraitLayout dynamic width', () => {
  it('keeps 1080 from 540 CSS px up and narrows phones toward a 0.5 scale', () => {
    expect(new PortraitLayout(768, 1024).designWidth).toBe(1080);
    expect(new PortraitLayout(540, 960).designWidth).toBe(1080);
    expect(new PortraitLayout(430, 932).designWidth).toBe(860);
    expect(new PortraitLayout(360, 640).designWidth).toBe(720);
    // Floor: a 320-wide screen stays at 720 and simply renders smaller (0.44x).
    expect(new PortraitLayout(320, 568).designWidth).toBe(720);
  });

  it.each([[390, 844], [360, 640], [320, 568], [430, 932]])(
    'scales the board so it still fits between the strips at %ix%i', (w, h) => {
      const l = new PortraitLayout(w, h);
      const k = l.designWidth / 1080;
      expect(l.cellSize).toBe(Math.floor(84 * k));
      expect(l.boardRect.x).toBeGreaterThanOrEqual(0);
      expect(l.boardRect.x + l.boardRect.w).toBeLessThanOrEqual(l.designWidth);
      expect(l.boardRect.y).toBeGreaterThanOrEqual(l.hudTopRect.h);
      expect(l.boardRect.y + l.boardRect.h).toBeLessThanOrEqual(l.hudBottomLeftRect.y);
      expect(l.handRect.y + l.handRect.h).toBe(l.designHeight);
      expect(l.hudBottomRightRect.x + l.hudBottomRightRect.w).toBe(l.designWidth);
      // Exactly the rule the layout sweep predicts (test/browser/lib/auditBox.ts designBox): a
      // pixel of drift moves the design scale and with it the legibility floor the sweep enforces.
      expect(l.designHeight).toBe(Math.max(Math.round(1920 * k), Math.round(l.designWidth * h / w)));
    });
});

describe('PortraitLayout dynamic height', () => {
  it('keeps the classic 1920 height and board origin at a 9:16 aspect', () => {
    // 1080×1920 aspect (0.5625). Any screen at this aspect → reference layout.
    const l = new PortraitLayout(540, 960);
    expect(l.designHeight).toBe(1920);
    // Board top matches the historical BOARD_Y (HUD_TOP_H = 70).
    expect(l.boardRect.y).toBe(70);
    expect(l.boardRect.x).toBe(36);
  });

  it('clamps to 1920 when the screen is wider than 9:16', () => {
    // 800×1280 (0.625, wider than 9:16) — aspectH < 1920 → clamped.
    const l = new PortraitLayout(800, 1280);
    expect(l.designHeight).toBe(1920);
    expect(l.boardRect.y).toBe(70);
  });

  it('grows the design height on a tall phone so there is no letterbox', () => {
    // iPhone 13 logical viewport: 390×844 (~9:19.5).
    const l = new PortraitLayout(390, 844);
    // Narrow screen → design width 390/0.5 = 780; height must match the screen aspect.
    expect(l.designWidth).toBe(780);
    expect(l.designHeight).toBe(Math.round(780 * 844 / 390));
    // Fit-to-width scale (screenW/designWidth) === fit-to-height scale → no letterbox.
    const scaleW = 390 / l.designWidth;
    const scaleH = 844 / l.designHeight;
    expect(Math.abs(scaleW - scaleH)).toBeLessThan(0.001);
  });

  it('anchors the top HUD to the top and the hand to the bottom on a tall phone', () => {
    const l = new PortraitLayout(390, 844);
    expect(l.hudTopRect.y).toBe(0);
    // Hand sits flush against the bottom edge (handRect.y + handRect.h === designHeight).
    expect(l.handRect.y + l.handRect.h).toBe(l.designHeight);
    // Board is centered between the two HUD strips (roughly symmetric margins).
    const topGap = l.boardRect.y - (l.hudTopRect.y + l.hudTopRect.h);
    const botGap = l.hudBottomLeftRect.y - (l.boardRect.y + l.boardRect.h);
    expect(Math.abs(topGap - botGap)).toBeLessThanOrEqual(1);
  });

  it('shrinks the design area for safe-area insets via createLayout', () => {
    // Insets reduce the drawable area, so the design height tracks the *safe*
    // aspect rather than the raw viewport aspect.
    const noInset = createLayout(390, 844);
    const inset   = createLayout(390, 844, undefined, { top: 47, right: 0, bottom: 34, left: 0 });
    // 390 × (844 − 47 − 34) = 390 × 763 → shorter design height than no-inset.
    expect(inset.designHeight).toBe(Math.round(780 * 763 / 390));
    expect(inset.designHeight).toBeLessThan(noInset.designHeight);
    // The layout itself always anchors its top HUD to its own top edge; the
    // ScalingManager offsets the whole layer into the safe region.
    expect(inset.hudTopRect.y).toBe(0);
    expect(noInset.hudTopRect.y).toBe(0);
  });

  // Regression: the base *sprite* rect must sit exactly where gridToScreen renders
  // that base's physical center, for BOTH host and joiner. gridToScreen mirrors the
  // board for the joiner (Side.Top), so the sprite rects must mirror to match — else
  // the castle art, upgrade tier, cracks and the under-attack hit outline all land on
  // the WRONG castle (the joiner saw the enemy's damage flash on their own base).
  it.each([
    { side: Side.Bottom, ownRow: 0.5,  enemyRow: 16.5 },
    { side: Side.Top,    ownRow: 16.5, enemyRow: 0.5  },
  ])('anchors base sprite rects to gridToScreen for localSide=$side', ({ side, ownRow, enemyRow }) => {
    const l = new PortraitLayout(540, 960, side);
    const center = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    expect(center(l.playerBaseRect())).toEqual(l.gridToScreen(5.5, ownRow));
    expect(center(l.enemyBaseRect())).toEqual(l.gridToScreen(5.5, enemyRow));
  });

  it('round-trips grid ↔ screen coordinates through the shifted board origin', () => {
    const l = new PortraitLayout(390, 844);
    for (const [col, row] of [[0, 0], [5, 9], [11, 17]] as const) {
      const p = l.gridToScreen(col, row);
      expect(l.screenToCol(p.x, p.y)).toBe(col);
      expect(l.screenToRow(p.x, p.y)).toBe(row);
    }
  });
});
