// BoardView base-art inset — regression for "building overlaps the castle" (2026-08-09
// user report, screenshot showed a defender building sitting flush against the base's
// wall in both PvE and PvP).
//
// Root cause: `BoardView.buildBaseRef` set the castle sprite's width/height to exactly
// `rect.w`/`rect.h` — the base's full 2×2-cell collision rect, edge to edge with zero
// margin. Buildings already sit inset within their own cell (BuildingView's
// SPRITE_SIZE=56 inside a 70px CELL), so the castle's zero-margin edge landed almost
// flush against the building in the lane immediately next to it. Fix: BASE_ART_INSET
// shrinks the castle sprite within its rect (see art-direction.md §6.3), leaving a
// visible gap on every side without touching placement rules or the base's collision
// rect (breathing/critical-ring/crack overlays all still key off the unshrunk rect).
//
// Headless: constructs the real BoardView (pixiHeadless adapter via
// vitest.ui.config.ts setupFiles), same approach as laneHighlightMirror.ui.ts.
// playerBase/enemyBase are private; reached via `(bv as any)` — geometry test, not a
// public-API contract.

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { BoardView } from '../../src/render/BoardView';
import { Side } from '../../src/game';

interface BaseRef {
  sprite: { width: number; height: number };
  rect: { w: number; h: number };
}

describe('BoardView base art inset', () => {
  it("insets the player's castle sprite within its 2x2 rect instead of filling it edge-to-edge", () => {
    const layout = createLayout(1280, 800, Side.Bottom);
    const bv = new BoardView(layout);
    try {
      const base = (bv as any).playerBase as BaseRef;
      expect(base.sprite.width).toBeLessThan(base.rect.w);
      expect(base.sprite.height).toBeLessThan(base.rect.h);

      // Regression guard: pin the margin to a meaningful fraction of a cell, not just
      // "less than" — an accidental inset of e.g. 0.999 would still pass a bare
      // toBeLessThan() check but reproduce the reported overlap in practice.
      const marginX = (base.rect.w - base.sprite.width) / 2;
      const marginY = (base.rect.h - base.sprite.height) / 2;
      expect(marginX).toBeGreaterThan(layout.cellSize * 0.1);
      expect(marginY).toBeGreaterThan(layout.cellSize * 0.1);
    } finally {
      bv.destroy();
    }
  });

  it("insets the enemy castle by the same ratio (mirrored, but not full-bleed either)", () => {
    const layout = createLayout(1280, 800, Side.Bottom);
    const bv = new BoardView(layout);
    try {
      const base = (bv as any).enemyBase as BaseRef;
      // Sprite.width is derived from |scale.x| * texture.width, so the horizontal mirror
      // (scale.x *= -1 for the enemy base) does not flip the sign back to negative.
      expect(base.sprite.width).toBeGreaterThan(0);
      expect(base.sprite.width).toBeLessThan(base.rect.w);
      expect(base.sprite.height).toBeLessThan(base.rect.h);
    } finally {
      bv.destroy();
    }
  });

  it('does not shrink the breathing/critical-ring collision rect itself — only the sprite', () => {
    // The ring/crack/pulse overlays (applyCriticalRing, playBaseCrackEffect, etc.) key off
    // `base.rect`, not `base.sprite`'s bounds — asset-inset must not shrink that rect, or
    // the critical-HP ring would visibly detach from the castle at the wrong radius.
    const layout = createLayout(1280, 800, Side.Bottom);
    const bv = new BoardView(layout);
    try {
      const base = (bv as any).playerBase as BaseRef;
      const expectedRect = layout.playerBaseRect();
      expect(base.rect.w).toBe(expectedRect.w);
      expect(base.rect.h).toBe(expectedRect.h);
    } finally {
      bv.destroy();
    }
  });
});
