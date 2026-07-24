// BoardView map-effect coverage for the two column-targeted spells whose on-board
// feedback was too easy to miss (断路 / 直线伤害):
//
//   • 断路 (BridgeCollapse) — syncBlockedLanes() paints a PERSISTENT barricade over a
//     blocked lane for its full 8s duration (the 0.6s cast VFX alone was missable),
//     then removes it when the lane reopens. One overlay Graphics per blocked column.
//   • 直线伤害 (Rockslide) — playRockslideEffect() runs a one-shot telegraph + cascade
//     down the whole lane via a single Ticker.shared effect, unregistered on teardown.
//
// The invariants pinned here:
//   1. A blocked lane adds exactly one overlay; clearing removes it; hasBlockedLanes()
//      tracks it; the "about to reopen" blink dims the overlay below its steady alpha.
//   2. The rockslide effect registers exactly one tracked Ticker.shared listener and
//      destroy() unregisters it — Ticker.shared is a GC root, so a leaked tick pins the
//      whole battle scene (client-memory-leak.md).
//
// Headless: constructs the real BoardView (pixiHeadless adapter via
// vitest.ui.config.ts). Private fields reached via `(bv as any)` — render internals,
// not a public-API contract.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { BoardView } from '../../src/render/BoardView';
import { Side } from '../../src/game';

describe('BoardView — 断路 persistent blocked-lane overlay', () => {
  it('adds one overlay per blocked lane, tracks it, and clears it when the lane reopens', () => {
    const bv = new BoardView(createLayout(1280, 800, Side.Bottom));
    try {
      const layer = (bv as any).blockedLaneLayer as PIXI.Container;

      expect(bv.hasBlockedLanes()).toBe(false);

      bv.syncBlockedLanes([{ col: 3, remainingSec: 5 }]);
      expect(bv.hasBlockedLanes()).toBe(true);
      expect(layer.children.length).toBe(1);

      // A second blocked lane adds a second overlay; the first is not rebuilt.
      const first = layer.children[0];
      bv.syncBlockedLanes([{ col: 3, remainingSec: 5 }, { col: 8, remainingSec: 5 }]);
      expect(layer.children.length).toBe(2);
      expect(layer.children).toContain(first); // reused, not recreated

      // Lane 3 reopens; only lane 8's overlay remains.
      bv.syncBlockedLanes([{ col: 8, remainingSec: 5 }]);
      expect(layer.children.length).toBe(1);
      expect(layer.children).not.toContain(first);

      // All clear.
      bv.syncBlockedLanes([]);
      expect(bv.hasBlockedLanes()).toBe(false);
      expect(layer.children.length).toBe(0);
    } finally {
      bv.destroy();
    }
  });

  it('blinks (dims below steady alpha) in the final seconds before the lane reopens', () => {
    const bv = new BoardView(createLayout(1280, 800, Side.Bottom));
    try {
      const layer = (bv as any).blockedLaneLayer as PIXI.Container;

      bv.syncBlockedLanes([{ col: 4, remainingSec: 5 }]); // plenty of time → steady
      expect((layer.children[0] as PIXI.Graphics).alpha).toBeCloseTo(0.9, 5);

      bv.syncBlockedLanes([{ col: 4, remainingSec: 0.5 }]); // about to reopen → blink
      expect((layer.children[0] as PIXI.Graphics).alpha).toBeLessThan(0.9);
    } finally {
      bv.destroy();
    }
  });
});

describe('BoardView — 直线伤害 rockslide sweep (Ticker.shared leak contract)', () => {
  it('registers exactly one tracked effect tick and destroy() unregisters it', () => {
    const bv = new BoardView(createLayout(1280, 800, Side.Bottom));
    const tickBefore = PIXI.Ticker.shared.count;
    const fxBefore   = (bv as any).fxTicks.size as number;

    bv.playRockslideEffect(4);
    expect((bv as any).fxTicks.size).toBe(fxBefore + 1);
    expect(PIXI.Ticker.shared.count).toBe(tickBefore + 1);

    bv.destroy();
    // Back to the pre-effect count — no orphaned tick pinning the scene as a GC root.
    expect(PIXI.Ticker.shared.count).toBe(tickBefore);
  });
});
