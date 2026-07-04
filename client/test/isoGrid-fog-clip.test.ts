/**
 * isoGrid-fog-clip.test.ts — regression tests for the 2026-07-03 "SLG map went blank" bug.
 *
 * WorldMapScene.renderFog() draws a cloud veil over the off-map area by filling the whole
 * viewport and punching the map's tile-area parallelogram out as a PIXI `beginHole()` hole.
 * The world map is up to 1500×1500 tiles, so that parallelogram's outer vertices project to
 * hundreds of thousands of px past the viewport. Feeding that raw polygon to earcut hole
 * triangulation FAILS silently, leaving the cloud rect a solid fill — which blanked the entire
 * map (you saw only beige paper + a faint camp doodle).
 *
 * The fix: clip the hole polygon to the viewport rect (clipConvexToRect) BEFORE punching it,
 * so the hole always has viewport-bounded coordinates. These tests lock in that invariant by
 * reconstructing renderFog's exact hole polygon and asserting the clipped result is (a) fully
 * inside the viewport and (b) still covers the whole viewport when a big map is centered
 * (so no veil covers the map).
 *
 * Pure geometry — no PIXI — so it runs in the main suite (npm test).
 */

import { describe, it, expect } from 'vitest';
import { tileToScreen, ISO_RATIO, clipConvexToRect } from '../src/render/isoGrid';

type Pt = { x: number; y: number };

/** Reconstruct renderFog()'s cloud-hole polygon (the map tile-area parallelogram). */
function fogHolePolygon(mapW: number, mapH: number, tp: number, panX: number, panY: number): Pt[] {
  const hw = tp / 2;
  const hh = (tp * ISO_RATIO) / 2;
  const top    = tileToScreen(0, 0, tp);
  const right  = tileToScreen(mapW - 1, 0, tp);
  const bottom = tileToScreen(mapW - 1, mapH - 1, tp);
  const left   = tileToScreen(0, mapH - 1, tp);
  return [
    { x: panX + top.x,        y: panY + top.y - hh },
    { x: panX + right.x + hw, y: panY + right.y },
    { x: panX + bottom.x,     y: panY + bottom.y + hh },
    { x: panX + left.x - hw,  y: panY + left.y },
  ];
}

/** pan that centers tile (cx,cy) in the viewport — mirrors WorldMapScene.centerAt(). */
function panCenteredOn(cx: number, cy: number, tp: number, w: number, viewH: number): { panX: number; panY: number } {
  const s = tileToScreen(cx, cy, tp);
  return { panX: w / 2 - s.x, panY: viewH / 2 - s.y };
}

/** True when `pt` is inside (or on the edge of) a convex polygon, winding-agnostic. */
function pointInConvex(pt: Pt, poly: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
    if (Math.abs(cross) < 1e-6) continue; // on an edge — doesn't break convexity
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Shoelace area (absolute). */
function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

const W = 1280;
const VIEW_H = 720; // viewport height minus HUD, exact value irrelevant to the invariant

describe('clipConvexToRect — fog veil hole clipping (SLG blank-map regression)', () => {
  it('the raw 1500×1500 hole polygon really does blow past the viewport (documents the bug scenario)', () => {
    const { panX, panY } = panCenteredOn(750, 750, 64, W, VIEW_H);
    const raw = fogHolePolygon(1500, 1500, 64, panX, panY);
    // A vertex sits tens of thousands of px outside [0,W]×[0,VIEW_H] — dozens of viewport
    // widths away. This is the polygon that used to be fed straight to earcut and broke it.
    const maxAbs = Math.max(...raw.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
    expect(maxAbs).toBeGreaterThan(W * 10);
  });

  it('clipping a big centered map yields a viewport-BOUNDED polygon (the fix earcut needs)', () => {
    const { panX, panY } = panCenteredOn(750, 750, 64, W, VIEW_H);
    const raw = fogHolePolygon(1500, 1500, 64, panX, panY);
    const clipped = clipConvexToRect(raw, W, VIEW_H);

    expect(clipped.length).toBeGreaterThanOrEqual(3);
    const eps = 1e-6;
    for (const p of clipped) {
      expect(p.x).toBeGreaterThanOrEqual(0 - eps);
      expect(p.x).toBeLessThanOrEqual(W + eps);
      expect(p.y).toBeGreaterThanOrEqual(0 - eps);
      expect(p.y).toBeLessThanOrEqual(VIEW_H + eps);
    }
  });

  it('a big centered map punches out the ENTIRE viewport (no veil left covering the map)', () => {
    const { panX, panY } = panCenteredOn(750, 750, 64, W, VIEW_H);
    const clipped = clipConvexToRect(fogHolePolygon(1500, 1500, 64, panX, panY), W, VIEW_H);

    // All four viewport corners fall inside the clipped hole → the cloud rect is fully
    // punched through → the map shows, not a beige blank. (This is the actual user-facing bug.)
    const corners: Pt[] = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: VIEW_H }, { x: 0, y: VIEW_H }];
    for (const c of corners) expect(pointInConvex(c, clipped)).toBe(true);
    // And the hole covers essentially the whole viewport area.
    expect(polygonArea(clipped)).toBeGreaterThan(W * VIEW_H * 0.999);
  });

  it('a map edge in view leaves a real (bounded, non-empty, partial) hole', () => {
    // Camera near the map's (0,0) corner so the top/left map edges sit inside the viewport.
    const { panX, panY } = panCenteredOn(3, 3, 64, W, VIEW_H);
    const clipped = clipConvexToRect(fogHolePolygon(1500, 1500, 64, panX, panY), W, VIEW_H);

    expect(clipped.length).toBeGreaterThanOrEqual(3);
    for (const p of clipped) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-6);
      expect(p.x).toBeLessThanOrEqual(W + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(-1e-6);
      expect(p.y).toBeLessThanOrEqual(VIEW_H + 1e-6);
    }
    const area = polygonArea(clipped);
    expect(area).toBeGreaterThan(0);
    // A corner of the map is on screen → some off-map region remains → hole < full viewport.
    expect(area).toBeLessThan(W * VIEW_H);
  });

  it('a polygon already inside the viewport is returned unchanged', () => {
    const inside: Pt[] = [{ x: 100, y: 100 }, { x: 300, y: 120 }, { x: 280, y: 400 }, { x: 90, y: 380 }];
    const clipped = clipConvexToRect(inside, W, VIEW_H);
    expect(clipped).toEqual(inside);
  });

  it('a polygon fully outside the viewport clips to empty', () => {
    const outside: Pt[] = [{ x: -500, y: -500 }, { x: -300, y: -500 }, { x: -300, y: -300 }, { x: -500, y: -300 }];
    expect(clipConvexToRect(outside, W, VIEW_H)).toHaveLength(0);
  });

  it('clips a triangle straddling the left edge to the visible half', () => {
    // Triangle with one vertex left of x=0; clipping introduces two boundary vertices on x=0.
    const tri: Pt[] = [{ x: -100, y: 360 }, { x: 400, y: 100 }, { x: 400, y: 620 }];
    const clipped = clipConvexToRect(tri, W, VIEW_H);
    expect(clipped.every((p) => p.x >= -1e-6)).toBe(true);
    // The clipped shape is smaller than the original triangle but non-degenerate.
    expect(polygonArea(clipped)).toBeGreaterThan(0);
    expect(polygonArea(clipped)).toBeLessThan(polygonArea(tri));
  });
});
