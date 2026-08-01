// Coverage for the 2026-08-01 world-map declutter pass's new drawing primitives in
// tileGraphics.ts: drawDashedPolygon (continuous dash phase across a polygon's edges — used
// by the occupy-frontier/garrison-zone strokes) and drawFadedLine (fixed-segment width/alpha
// ramp with an end hold — used by march-route lines). These are standalone PIXI.Graphics
// drawing primitives with no scene state, so plain PIXI.Graphics spying is enough; no
// WorldMapContext/scene needed (unlike worldMapOwnerBorder.ui.ts).
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawDashedPolygon, drawFadedLine } from '../../src/scenes/worldmap/tileGraphics';

function spyMoveLine(g: PIXI.Graphics): { moves: [number, number][]; lines: [number, number][] } {
  const moves: [number, number][] = [];
  const lines: [number, number][] = [];
  vi.spyOn(g, 'moveTo').mockImplementation(function (this: PIXI.Graphics, x: number, y: number) {
    moves.push([x, y]); return this;
  });
  vi.spyOn(g, 'lineTo').mockImplementation(function (this: PIXI.Graphics, x: number, y: number) {
    lines.push([x, y]); return this;
  });
  return { moves, lines };
}

describe('drawDashedPolygon (2026-08-01 declutter pass)', () => {
  it('draws exactly one dash per edge when each edge length is a whole multiple of the dash+gap cycle', () => {
    const g = new PIXI.Graphics();
    const { moves } = spyMoveLine(g);
    // 10x10 square, 4 edges of length 10 each; dash=4/gap=6 → cycle=10 divides each edge
    // exactly, so phase naturally lands back on 0 at every vertex — a degenerate case that
    // can't distinguish continuous-phase from a naive per-edge reset, just a baseline check.
    drawDashedPolygon(g, [0, 0, 10, 0, 10, 10, 0, 10], 4, 6);
    expect(moves).toHaveLength(4);
  });

  it("carries the dash phase across a vertex instead of resetting it (regression: a naive per-edge reset would collapse the long edge into a single dash)", () => {
    const g = new PIXI.Graphics();
    const { moves, lines } = spyMoveLine(g);
    // Thin rectangle: edges A(len100) B(len1) C(len100) D(len1), dash=50/gap=50 (cycle=100).
    // Edge A ends exactly on a cycle boundary (phase 0). Edge B (length 1) is fully inside a
    // dash and leaves a 1-unit carried phase. Edge C inherits that 1-unit offset, so it must
    // split into TWO dash segments (49, then after the gap, 1) instead of one clean 50-unit
    // dash starting fresh at its own beginning — only possible if phase survives the B→C vertex.
    drawDashedPolygon(g, [0, 0, 100, 0, 100, 1, 0, 1], 50, 50);
    // A:1 + B:1 + C:2 + D:1 = 5 total dash segments.
    expect(moves).toHaveLength(5);
    expect(lines).toHaveLength(5);
    // Edge C's two dash starts sit on the y=1 edge at x>0 (edge D's single dash also starts at
    // y=1 but at x=0 — exclude it so this only counts edge C's segments).
    const onEdgeC = moves.filter(([x, y]) => y === 1 && x > 0);
    expect(onEdgeC).toHaveLength(2);
  });

  it('draws nothing for a degenerate dash/gap cycle (dashLen+gapLen <= 0)', () => {
    const g = new PIXI.Graphics();
    const { moves } = spyMoveLine(g);
    drawDashedPolygon(g, [0, 0, 10, 0, 10, 10, 0, 10], 0, 0);
    expect(moves).toHaveLength(0);
  });
});

describe('drawFadedLine (2026-08-01 declutter pass)', () => {
  function spyLineStyle(g: PIXI.Graphics): { width: number; alpha: number }[] {
    const calls: { width: number; alpha: number }[] = [];
    vi.spyOn(g, 'lineStyle').mockImplementation(function (
      this: PIXI.Graphics, width?: number, _color?: number, alpha?: number,
    ) {
      calls.push({ width: Number(width ?? 0), alpha: Number(alpha ?? 1) });
      return this;
    });
    return calls;
  }

  it('ramps width/alpha from the start value up to the end value across a fixed segment count', () => {
    const g = new PIXI.Graphics();
    const calls = spyLineStyle(g);
    drawFadedLine(g, 0, 0, 100, 0, 0xff0000, 2, 0.3, 8, 0.9, 0.28, 9);
    // segments=9 draw calls, plus the trailing g.lineStyle(0) reset.
    expect(calls).toHaveLength(10);
    const segs = calls.slice(0, 9);
    expect(segs[0].width).toBeLessThan(segs[segs.length - 1].width);
    expect(segs[0].alpha).toBeLessThan(segs[segs.length - 1].alpha);
    // Holds at full strength for the tail — the last segment must land exactly on the end values.
    expect(segs[segs.length - 1].width).toBeCloseTo(8, 5);
    expect(segs[segs.length - 1].alpha).toBeCloseTo(0.9, 5);
  });

  it('holds the end value for the tail once past holdFrac, instead of ramping the whole way', () => {
    const g = new PIXI.Graphics();
    const calls = spyLineStyle(g);
    drawFadedLine(g, 0, 0, 40, 0, 0x0000ff, 1, 0.2, 5, 1, 0.5, 4);
    const segs = calls.slice(0, 4);
    // With holdFrac=0.5 and 4 segments, segments 2-4 (t1 >= 0.5) are already past the ramp window.
    expect(segs[1].width).toBeCloseTo(5, 5);
    expect(segs[2].width).toBeCloseTo(5, 5);
    expect(segs[3].width).toBeCloseTo(5, 5);
    // Only the very first segment is still mid-ramp.
    expect(segs[0].width).toBeLessThan(5);
  });

  it('draws the full route from (x0,y0) to (x1,y1) across its segments', () => {
    const g = new PIXI.Graphics();
    const { moves, lines } = spyMoveLine(g);
    drawFadedLine(g, 10, 20, 110, 20, 0x00ff00, 1, 0.2, 4, 0.9, 0.25, 5);
    expect(moves[0]).toEqual([10, 20]);
    expect(lines[lines.length - 1]).toEqual([110, 20]);
  });
});
