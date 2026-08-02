// isoGrid — the 2:1 isometric projection every pointer interaction and every tile placement goes
// through. A sign error here doesn't crash; it silently paints the wrong tile under the cursor,
// which is exactly the class of bug a round-trip test catches.
import { describe, expect, it } from 'vitest';
import {
  clipConvexToRect,
  diamondPath,
  diamondVertices,
  ISO_RATIO,
  screenToTile,
  screenToTileF,
  tileToScreen,
  visibleTileBounds,
} from '../src/render/isoGrid';

const TP = 80;

describe('tileToScreen / screenToTileF', () => {
  it('round-trips exactly for a spread of tiles and zoom levels', () => {
    for (const tileW of [10, 37, 80, 130]) {
      for (const [tx, ty] of [[0, 0], [1, 0], [0, 1], [17, 3], [499, 499], [1499, 1499]]) {
        const s = tileToScreen(tx!, ty!, tileW);
        const back = screenToTileF(s.x, s.y, tileW);
        expect(back.x).toBeCloseTo(tx!, 9);
        expect(back.y).toBeCloseTo(ty!, 9);
      }
    }
  });

  it('places the origin tile at the screen origin', () => {
    expect(tileToScreen(0, 0, TP)).toEqual({ x: 0, y: 0 });
  });

  it('projects +x to the right-and-down and +y to the left-and-down (standard 2:1 diamond)', () => {
    expect(tileToScreen(1, 0, TP)).toEqual({ x: TP / 2, y: (TP * ISO_RATIO) / 2 });
    expect(tileToScreen(0, 1, TP)).toEqual({ x: -TP / 2, y: (TP * ISO_RATIO) / 2 });
  });

  it('moving along the tile diagonal (1,1) is a pure vertical screen move', () => {
    const s = tileToScreen(1, 1, TP);
    expect(s.x).toBe(0);
    expect(s.y).toBe(TP * ISO_RATIO);
  });

  it('is linear, so the brush-outline ellipse sampling in overlay.ts is valid', () => {
    const a = tileToScreen(3, 5, TP);
    const b = tileToScreen(11, 2, TP);
    const sum = tileToScreen(14, 7, TP);
    expect(sum.x).toBeCloseTo(a.x + b.x, 9);
    expect(sum.y).toBeCloseTo(a.y + b.y, 9);
  });
});

describe('screenToTile', () => {
  it('floors the fractional result to the containing tile', () => {
    const inside = tileToScreen(12.4, 7.8, TP);
    expect(screenToTile(inside.x, inside.y, TP)).toEqual({ x: 12, y: 7 });
  });

  it('a tile center maps back to that tile', () => {
    for (const [tx, ty] of [[0, 0], [5, 9], [300, 12]]) {
      // tileToScreen returns the tile's ORIGIN; nudge into its interior before flooring.
      const s = tileToScreen(tx! + 0.5, ty! + 0.5, TP);
      expect(screenToTile(s.x, s.y, TP)).toEqual({ x: tx, y: ty });
    }
  });

  it('goes negative off the top-left of the map (callers are responsible for clamping)', () => {
    const t = screenToTile(-5 * TP, -5 * TP, TP);
    expect(t.x).toBeLessThan(0);
    expect(t.y).toBeLessThan(0);
  });
});

describe('diamondPath / diamondVertices', () => {
  it('is a 4-point diamond of width tileW and height tileW*ISO_RATIO', () => {
    const p = diamondPath(TP);
    expect(p).toHaveLength(8);
    const xs = p.filter((_, i) => i % 2 === 0);
    const ys = p.filter((_, i) => i % 2 === 1);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(TP, 9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(TP * ISO_RATIO, 9);
  });

  it('inset shrinks uniformly toward the center', () => {
    const p = diamondPath(TP, { inset: 0.2 });
    const xs = p.filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(TP * 0.8, 9);
  });

  it('vertices match the path corners', () => {
    const v = diamondVertices(TP);
    expect(v.top).toEqual([0, -(TP * ISO_RATIO) / 2]);
    expect(v.right).toEqual([TP / 2, 0]);
    expect(v.bottom).toEqual([0, (TP * ISO_RATIO) / 2]);
    expect(v.left).toEqual([-TP / 2, 0]);
  });
});

describe('visibleTileBounds', () => {
  it('covers every tile whose projection lands inside the screen rect', () => {
    const screenW = 900;
    const screenH = 620;
    const panX = 150;
    const panY = 90;
    const b = visibleTileBounds(screenW, screenH, panX, panY, TP);
    // Sample the screen rect densely; every sampled point's tile must be inside the reported bounds.
    for (let sy = 0; sy <= screenH; sy += 20) {
      for (let sx = 0; sx <= screenW; sx += 20) {
        const t = screenToTile(sx - panX, sy - panY, TP);
        expect(t.x).toBeGreaterThanOrEqual(b.minTx);
        expect(t.x).toBeLessThanOrEqual(b.maxTx);
        expect(t.y).toBeGreaterThanOrEqual(b.minTy);
        expect(t.y).toBeLessThanOrEqual(b.maxTy);
      }
    }
  });

  it('is wider than the naive orthogonal screenW/tileW estimate (the rect back-projects to a diamond)', () => {
    const b = visibleTileBounds(900, 620, 0, 0, TP);
    expect(b.maxTx - b.minTx).toBeGreaterThan(900 / TP);
  });

  it('zooming in shrinks the covered tile range', () => {
    const wide = visibleTileBounds(900, 620, 0, 0, 20);
    const close = visibleTileBounds(900, 620, 0, 0, 120);
    expect(close.maxTx - close.minTx).toBeLessThan(wide.maxTx - wide.minTx);
  });
});

describe('clipConvexToRect', () => {
  it('leaves a fully contained polygon alone', () => {
    const pts = [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 30 }];
    expect(clipConvexToRect(pts, 100, 100)).toEqual(pts);
  });

  it('collapses a polygon that covers the whole rect to the rect itself', () => {
    const huge = [{ x: -1e6, y: -1e6 }, { x: 1e6, y: -1e6 }, { x: 1e6, y: 1e6 }, { x: -1e6, y: 1e6 }];
    const out = clipConvexToRect(huge, 100, 50);
    const xs = out.map((p) => p.x);
    const ys = out.map((p) => p.y);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(100);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(50);
  });

  it('clamps a partially overhanging polygon into the rect', () => {
    const out = clipConvexToRect([{ x: -50, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 40 }], 100, 100);
    expect(out.length).toBeGreaterThan(0);
    for (const p of out) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(100);
    }
  });

  it('returns empty for a polygon entirely outside the rect', () => {
    expect(clipConvexToRect([{ x: 200, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 300 }], 100, 100)).toEqual([]);
  });
});
