/**
 * isoGrid-screenToTile.test.ts — regression tests for the 2026-07-12 "clicking a tile selects
 * a neighboring tile" bug.
 *
 * `tileToScreen(tx,ty)` places each tile's CENTER at the projected screen point (see its doc
 * comment). That means in the exact-inverse fractional space `screenToTileF` returns, a tile's
 * true footprint is `[tx-0.5, tx+0.5)`, not `[tx, tx+1)`. `screenToTile` used `Math.floor` on
 * that fractional result — correct only for a corner-anchored mapping — which shifted every
 * click's hit-test half a tile toward higher tx/ty. A click on the "early" half of a tile's
 * actual footprint resolved to the previous tile (up-left in iso-screen space), exactly matching
 * the observed symptom of a click selecting the neighboring diamond instead of the one clicked.
 *
 * The fix: round to the nearest integer (`Math.floor(x + 0.5)`) instead of flooring. These
 * tests lock in that a click anywhere within a tile's diamond — including near its edges —
 * resolves back to that same tile.
 *
 * Pure geometry — no PIXI — runs in the main suite (npm test).
 */

import { describe, it, expect } from 'vitest';
import { tileToScreen, screenToTile, diamondVertices } from '../src/render/isoGrid';

const TILE_W = 100;

describe('screenToTile — tile-click hit-testing (2026-07-12 neighbor-tile regression)', () => {
  it('a click exactly at a tile\'s center resolves to that tile', () => {
    for (const [tx, ty] of [[0, 0], [5, 5], [12, 3], [3, 12], [40, 1]] as const) {
      const c = tileToScreen(tx, ty, TILE_W);
      expect(screenToTile(c.x, c.y, TILE_W)).toEqual({ x: tx, y: ty });
    }
  });

  it('clicks just off-center in every direction still resolve to the clicked tile', () => {
    const tx = 5, ty = 5;
    const c = tileToScreen(tx, ty, TILE_W);
    const offsets = [
      [10, 0], [-10, 0], [0, 10], [0, -10], [7, 7], [-7, -7], [7, -7], [-7, 7],
    ];
    for (const [dx, dy] of offsets) {
      expect(screenToTile(c.x + dx, c.y + dy, TILE_W)).toEqual({ x: tx, y: ty });
    }
  });

  it('a click just inside each of the tile diamond\'s four vertices still resolves to that tile', () => {
    const tx = 8, ty = 3;
    const c = tileToScreen(tx, ty, TILE_W);
    const v = diamondVertices(TILE_W);
    // Pull each vertex 1% toward the center so the point is strictly inside the diamond,
    // not exactly on its boundary (which is ambiguous between neighbors by construction).
    const shrink = 0.99;
    for (const [vx, vy] of [v.top, v.right, v.bottom, v.left]) {
      const sx = c.x + vx * shrink;
      const sy = c.y + vy * shrink;
      expect(screenToTile(sx, sy, TILE_W)).toEqual({ x: tx, y: ty });
    }
  });

  it('does not reproduce the pre-fix floor() regression (click past center used to pick the neighbor)', () => {
    // A point 10px right of tile (5,5)'s center is still well within its diamond, but the old
    // floor()-based screenToTile resolved it to (5,4) — the tile "before" it in iso-screen space.
    const tx = 5, ty = 5;
    const c = tileToScreen(tx, ty, TILE_W);
    expect(screenToTile(c.x + 10, c.y, TILE_W)).toEqual({ x: tx, y: ty });
    expect(screenToTile(c.x + 10, c.y, TILE_W)).not.toEqual({ x: tx, y: ty - 1 });
  });

  it('adjacent tiles have non-overlapping, gapless footprints along both axes', () => {
    // Points swept just past the boundary between (5,5) and (6,5) should flip cleanly.
    const a = tileToScreen(5, 5, TILE_W);
    const b = tileToScreen(6, 5, TILE_W);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    expect(screenToTile(midX - 1, midY, TILE_W)).toEqual({ x: 5, y: 5 });
    expect(screenToTile(midX + 1, midY, TILE_W)).toEqual({ x: 6, y: 5 });
  });
});
