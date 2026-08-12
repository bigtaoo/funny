// Low-priority coverage gaps identified while auditing the tileGraphics.ts -> tileGraphics/
// {tiles,resources,primitives}.ts form① split (2026-08-12, see claudedocs/client-modules.md):
// drawStar (primitives.ts) and motifJitter (resources.ts) had NO test coverage, direct or
// indirect — drawStar is only reachable via WorldMapRenderer/fog.ts's capital-marker loop, which
// no existing test exercises (nothing sets ctx.nations), and motifJitter is only reachable via
// drawResMotif, whose own atlas-mocking tests (if any existed) never assert on jitter output.
// Both are pure, cheap to pin directly, and both carry a "must stay in lockstep with the
// map-editor's identical helper" parity contract (per their own doc comments) that only
// determinism protects — a drive-by change to either formula would silently break parity with no
// test noticing. Added per the form① split audit's "cheap to pin directly" guidance; not meant to
// be exhaustive coverage of tileGraphics.ts.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawStar, motifJitter } from '../../src/scenes/worldmap/tileGraphics';

describe('motifJitter (2026-07-12 resource-carpet declutter pass)', () => {
  it('is deterministic: the same (tx, ty) always produces the same jitter (no shimmer on redraw/pan)', () => {
    const a = motifJitter(37, -12);
    const b = motifJitter(37, -12);
    expect(b).toEqual(a);
  });

  it('different tiles get different jitter (not a constant fallback)', () => {
    const a = motifJitter(0, 0);
    const b = motifJitter(1, 0);
    expect(b).not.toEqual(a);
  });

  it('every output stays within its documented bound (dx/dy small fractions of tp, scale near 1)', () => {
    // Sample a spread of integer tile coordinates — the hash is coordinate-based, not random, so
    // this is a deterministic sweep, not a flaky property test.
    for (let tx = -5; tx <= 5; tx++) {
      for (let ty = -5; ty <= 5; ty++) {
        const j = motifJitter(tx, ty);
        expect(Math.abs(j.dx)).toBeLessThanOrEqual(0.13);
        expect(Math.abs(j.dy)).toBeLessThanOrEqual(0.09);
        expect(Math.abs(j.rot)).toBeLessThanOrEqual(0.35);
        expect(j.scale).toBeGreaterThanOrEqual(0.85);
        expect(j.scale).toBeLessThanOrEqual(1.15);
      }
    }
  });
});

describe('drawStar (L3 overview / capital markers)', () => {
  function spy(g: PIXI.Graphics): {
    polygons: number[][]; fills: { color: number; alpha: number }[]; endFillMarks: true[];
  } {
    const polygons: number[][] = [];
    const fills: { color: number; alpha: number }[] = [];
    const endFillMarks: true[] = [];
    vi.spyOn(g, 'drawPolygon').mockImplementation(function (this: PIXI.Graphics, pts: unknown) {
      polygons.push(pts as number[]); return this;
    });
    vi.spyOn(g, 'beginFill').mockImplementation(function (this: PIXI.Graphics, color?: unknown, alpha?: unknown) {
      fills.push({ color: Number(color ?? 0), alpha: Number(alpha ?? 1) }); return this;
    });
    vi.spyOn(g, 'endFill').mockImplementation(function (this: PIXI.Graphics) {
      endFillMarks.push(true); return this;
    });
    return { polygons, fills, endFillMarks };
  }

  it('draws a 10-point star (5 outer + 5 inner vertices)', () => {
    const g = new PIXI.Graphics();
    const { polygons } = spy(g);
    drawStar(g, 100, 100, 20, 0xffcc00, false);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]).toHaveLength(20); // 10 points x (x,y)
  });

  it('unfilled (unowned nation): does not beginFill/endFill', () => {
    const g = new PIXI.Graphics();
    const { fills, endFillMarks } = spy(g);
    drawStar(g, 100, 100, 20, 0xccb890, false);
    expect(fills).toHaveLength(0);
    expect(endFillMarks).toHaveLength(0);
  });

  it('filled (owned nation): fills with the given color at alpha 0.95', () => {
    const g = new PIXI.Graphics();
    const { fills, endFillMarks } = spy(g);
    drawStar(g, 100, 100, 20, 0xffcc00, true);
    expect(fills).toEqual([{ color: 0xffcc00, alpha: 0.95 }]);
    expect(endFillMarks).toHaveLength(1);
  });

  it('is deterministic: identical inputs always produce identical vertex positions (per-vertex wobble is index-seeded, not random)', () => {
    const g1 = new PIXI.Graphics();
    const { polygons: p1 } = spy(g1);
    drawStar(g1, 50, 60, 15, 0x123456, false);

    const g2 = new PIXI.Graphics();
    const { polygons: p2 } = spy(g2);
    drawStar(g2, 50, 60, 15, 0x123456, false);

    expect(p2[0]).toEqual(p1[0]);
  });

  it('outer tips sit farther from center than inner notches (recognizable star silhouette, not a circle)', () => {
    const g = new PIXI.Graphics();
    const { polygons } = spy(g);
    const cx = 0, cy = 0, r = 20;
    drawStar(g, cx, cy, r, 0xffffff, false);
    const pts = polygons[0]!;
    const dists: number[] = [];
    for (let i = 0; i < pts.length / 2; i++) {
      dists.push(Math.hypot(pts[i * 2]! - cx, pts[i * 2 + 1]! - cy));
    }
    // Even-index vertices are outer tips (~r), odd-index are inner notches (~0.45r) — the jitter
    // is small (<=14% of r) so the two tiers never cross.
    for (let i = 0; i < dists.length; i++) {
      if (i % 2 === 0) expect(dists[i]).toBeGreaterThan(r * 0.7);
      else expect(dists[i]).toBeLessThan(r * 0.7);
    }
  });
});
