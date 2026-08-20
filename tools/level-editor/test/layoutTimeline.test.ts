// src/layout/timeline.ts — the timeline panel's PURE layer: tick<->pixel transforms, lane rows,
// wave-entry block rectangles, block hit-testing, the ruler/grid step, and the drag-snap and
// pan/zoom arithmetic (DESIGN.md §9).
//
// Phase 4 (2026-08-13) exported six of these off TimelinePanel as free functions taking
// `pxPerSec`/`scrollX` explicitly; ADR-070 Phase 4b (2026-08-20) moved the pure half out of the
// canvas-owning class into src/layout/timeline.ts so a directory-level coverage.include can reach
// it, and lifted the remaining pure decisions (blockRect / unitTickXs / blockLabel / gridStepSec /
// visibleSecondRange / snapAtTick / zoomAround / panBy) out of onMove/onWheel and the draw methods.
// TimelinePanel itself stays out of scope — it builds a real <canvas>/ResizeObserver/window
// listeners in its constructor and this editor has no headless-DOM harness.
import { describe, it, expect } from 'vitest';
import { ATTACK_LANES } from '@nw/engine/config';
import { TICK_RATE } from '@nw/engine/math/fixed';
import { UnitType } from '@nw/engine/types';
import type { WaveEntry } from '@nw/engine/campaign/LevelDefinition';
import { unitMeta } from '../src/units';
import {
  C,
  GUTTER_W,
  LANE_H,
  RULER_H,
  SNAP_TICKS,
  blockLabel,
  blockRect,
  canvasHeight,
  entryEndTick,
  gridStepSec,
  hitTest,
  isBlockVisible,
  isMajorSecond,
  laneColAt,
  laneIndex,
  panBy,
  snapAtTick,
  tickToX,
  unitTickXs,
  visibleSecondRange,
  xToTick,
  yToLaneIndex,
  zoomAround,
} from '../src/layout/timeline';

const PPS = 70;

function entry(partial: Partial<WaveEntry> & Pick<WaveEntry, 'atTick' | 'col'>): WaveEntry {
  return { unitType: UnitType.Infantry, count: 1, ...partial };
}

describe('tickToX / xToTick', () => {
  it('places tick 0 at the gutter edge when unscrolled', () => {
    expect(tickToX(0, PPS, 0)).toBe(GUTTER_W);
  });

  it('advances one pxPerSec-worth of pixels per second of ticks', () => {
    expect(tickToX(TICK_RATE, PPS, 0)).toBe(GUTTER_W + PPS);
  });

  it('shifts left by scrollX', () => {
    expect(tickToX(0, PPS, 40)).toBe(GUTTER_W - 40);
  });

  it('xToTick inverts tickToX', () => {
    const x = tickToX(TICK_RATE * 2.5, PPS, 30);
    expect(xToTick(x, PPS, 30)).toBeCloseTo(TICK_RATE * 2.5);
  });
});

describe('laneIndex', () => {
  it('returns the row index of a valid attack-lane column', () => {
    expect(laneIndex(ATTACK_LANES[0])).toBe(0);
    expect(laneIndex(ATTACK_LANES[ATTACK_LANES.length - 1])).toBe(ATTACK_LANES.length - 1);
  });

  it('returns -1 for a column that is not an attack lane', () => {
    expect(laneIndex(5)).toBe(-1); // a base column, per BoardPanel's BASE_COLS
  });
});

describe('yToLaneIndex', () => {
  it('is 0 for the first row, directly under the ruler', () => {
    expect(yToLaneIndex(RULER_H)).toBe(0);
  });

  it('advances one lane per LANE_H pixels', () => {
    expect(yToLaneIndex(RULER_H + LANE_H)).toBe(1);
    expect(yToLaneIndex(RULER_H + LANE_H * 3.5)).toBe(3);
  });

  it('is negative above the ruler (caller is expected to range-check)', () => {
    expect(yToLaneIndex(0)).toBeLessThan(0);
  });
});

describe('entryEndTick', () => {
  it('equals atTick for a single-unit group', () => {
    expect(entryEndTick(entry({ atTick: 100, col: ATTACK_LANES[0], count: 1 }))).toBe(100);
  });

  it('spans (count-1)*spacingTicks past atTick for a multi-unit group', () => {
    expect(entryEndTick(entry({ atTick: 100, col: ATTACK_LANES[0], count: 4, spacingTicks: 5 }))).toBe(100 + 3 * 5);
  });

  it('treats a missing spacingTicks as 0 regardless of count', () => {
    expect(entryEndTick(entry({ atTick: 100, col: ATTACK_LANES[0], count: 4 }))).toBe(100);
  });
});

describe('hitTest', () => {
  const lane0 = ATTACK_LANES[0];
  const lane1 = ATTACK_LANES[1];
  const entries: WaveEntry[] = [
    entry({ atTick: 0, col: lane0 }),
    entry({ atTick: TICK_RATE * 5, col: lane1 }),
  ];

  it('hits the block under the cursor on its lane row', () => {
    const x = tickToX(0, PPS, 0) + 2; // just inside the first block
    const y = RULER_H + laneIndex(lane0) * LANE_H + LANE_H / 2;
    expect(hitTest(x, y, entries, ATTACK_LANES.length, PPS, 0)).toBe(0);
  });

  it('returns null above the ruler / outside every lane row', () => {
    expect(hitTest(100, 0, entries, ATTACK_LANES.length, PPS, 0)).toBeNull();
  });

  it('returns null on a lane row with no matching entry', () => {
    const emptyLaneIdx = ATTACK_LANES.findIndex((c) => c !== lane0 && c !== lane1);
    const y = RULER_H + emptyLaneIdx * LANE_H + LANE_H / 2;
    expect(hitTest(tickToX(0, PPS, 0), y, entries, ATTACK_LANES.length, PPS, 0)).toBeNull();
  });

  it('returns the last matching entry\'s index when blocks overlap on the same lane (topmost-drawn wins)', () => {
    const overlapping: WaveEntry[] = [
      entry({ atTick: 0, col: lane0 }),
      entry({ atTick: 0, col: lane0 }),
    ];
    const x = tickToX(0, PPS, 0) + 2;
    const y = RULER_H + laneIndex(lane0) * LANE_H + LANE_H / 2;
    expect(hitTest(x, y, overlapping, ATTACK_LANES.length, PPS, 0)).toBe(1);
  });
});

// ── Phase 4b additions: the pure decisions that used to sit inside onMove/onWheel + the draw methods ──

const lane0 = ATTACK_LANES[0]!;

describe('laneColAt', () => {
  it('returns the lane column of the row under the cursor', () => {
    expect(laneColAt(RULER_H + LANE_H / 2, ATTACK_LANES.length)).toBe(lane0);
    expect(laneColAt(RULER_H + LANE_H + LANE_H / 2, ATTACK_LANES.length)).toBe(ATTACK_LANES[1]);
  });

  it('returns null above the ruler and below the last lane row', () => {
    expect(laneColAt(0, ATTACK_LANES.length)).toBeNull();
    expect(laneColAt(RULER_H + ATTACK_LANES.length * LANE_H, ATTACK_LANES.length)).toBeNull();
  });

  it('agrees with yToLaneIndex on where the rows are', () => {
    const y = RULER_H + 2 * LANE_H + 3;
    expect(laneColAt(y, ATTACK_LANES.length)).toBe(ATTACK_LANES[yToLaneIndex(y)]);
  });
});

describe('canvasHeight', () => {
  it('is the ruler strip plus one row per lane', () => {
    expect(canvasHeight(ATTACK_LANES.length)).toBe(RULER_H + ATTACK_LANES.length * LANE_H);
    expect(canvasHeight(0)).toBe(RULER_H);
  });
});

describe('blockRect', () => {
  it('starts at the entry\'s atTick and sits inset inside its lane row', () => {
    const r = blockRect(entry({ atTick: 0, col: lane0 }), 0, PPS, 0);
    expect(r.x).toBe(tickToX(0, PPS, 0));
    expect(r.y).toBe(RULER_H + 4);
    expect(r.h).toBe(LANE_H - 8);
  });

  it('is a minimum-width stub for a single unit', () => {
    expect(blockRect(entry({ atTick: 0, col: lane0, count: 1 }), 0, PPS, 0).w).toBe(18);
  });

  it('spans the group\'s last unit plus the same trailing pad', () => {
    const e = entry({ atTick: 0, col: lane0, count: 3, spacingTicks: TICK_RATE });
    const r = blockRect(e, 0, PPS, 0);
    expect(r.w).toBeCloseTo(2 * PPS + 18); // two 1s gaps of pxPerSec, plus the pad
  });

  it('moves with pan and scales with zoom, keeping its row', () => {
    const e = entry({ atTick: TICK_RATE, col: lane0 });
    expect(blockRect(e, 1, PPS, 40).x).toBe(blockRect(e, 1, PPS, 0).x - 40);
    expect(blockRect(e, 1, PPS * 2, 0).x - GUTTER_W).toBe((blockRect(e, 1, PPS, 0).x - GUTTER_W) * 2);
    expect(blockRect(e, 1, PPS, 0).y).toBe(RULER_H + LANE_H + 4);
  });

  // The load-bearing reason blockRect exists as one function: before Phase 4b the right edge was
  // computed twice, by drawBlocks (as a width) and by hitTest (as an x1), from two different
  // expressions. Clicking exactly the drawn edge has to hit the block.
  it('bounds exactly what hitTest grabs, at both edges', () => {
    const e = entry({ atTick: TICK_RATE * 2, col: lane0, count: 4, spacingTicks: 6 });
    const entries = [e];
    const y = RULER_H + laneIndex(lane0) * LANE_H + LANE_H / 2;
    const r = blockRect(e, laneIndex(lane0), PPS, 0);
    expect(hitTest(r.x + r.w, y, entries, ATTACK_LANES.length, PPS, 0)).toBe(0);
    expect(hitTest(r.x + r.w + 1, y, entries, ATTACK_LANES.length, PPS, 0)).toBeNull();
    // the left edge has a few px of grab slack, deliberately
    expect(hitTest(r.x - 4, y, entries, ATTACK_LANES.length, PPS, 0)).toBe(0);
    expect(hitTest(r.x - 5, y, entries, ATTACK_LANES.length, PPS, 0)).toBeNull();
  });
});

describe('isBlockVisible', () => {
  const rect = { x: 100, y: 0, w: 50, h: 20 };

  it('is visible while any part overlaps the area right of the gutter', () => {
    expect(isBlockVisible(rect, 800)).toBe(true);
    expect(isBlockVisible({ ...rect, x: GUTTER_W - rect.w }, 800)).toBe(true);
  });

  it('is hidden once it is entirely left of the gutter or entirely right of the canvas', () => {
    expect(isBlockVisible({ ...rect, x: GUTTER_W - rect.w - 1 }, 800)).toBe(false);
    expect(isBlockVisible({ ...rect, x: 801 }, 800)).toBe(false);
  });
});

describe('unitTickXs', () => {
  it('is empty for a single unit and for zero spacing', () => {
    expect(unitTickXs(entry({ atTick: 0, col: lane0, count: 1, spacingTicks: 6 }), PPS, 0)).toEqual([]);
    expect(unitTickXs(entry({ atTick: 0, col: lane0, count: 5, spacingTicks: 0 }), PPS, 0)).toEqual([]);
    expect(unitTickXs(entry({ atTick: 0, col: lane0, count: 5 }), PPS, 0)).toEqual([]);
  });

  it('emits one x per unit after the first, at atTick + k*spacing', () => {
    const e = entry({ atTick: 30, col: lane0, count: 3, spacingTicks: 6 });
    expect(unitTickXs(e, PPS, 0)).toEqual([tickToX(36, PPS, 0), tickToX(42, PPS, 0)]);
  });

  it('stops at the last unit, i.e. at entryEndTick', () => {
    const e = entry({ atTick: 0, col: lane0, count: 4, spacingTicks: 5 });
    const xs = unitTickXs(e, PPS, 0);
    expect(xs.length).toBe(3);
    expect(xs[xs.length - 1]).toBe(tickToX(entryEndTick(e), PPS, 0));
  });
});

describe('blockLabel', () => {
  it('is "label×count" for a known unit type', () => {
    expect(blockLabel(entry({ atTick: 0, col: lane0, unitType: UnitType.Archer, count: 3 })))
      .toBe(`${unitMeta(UnitType.Archer).label}\u00d73`);
  });

  it('appends a star for a boss entry', () => {
    expect(blockLabel(entry({ atTick: 0, col: lane0, count: 1, isBoss: true }))).toMatch(/ \u2605$/);
  });

  it('labels a unit type with no META entry by its raw enum value', () => {
    // units.ts's fallback already substitutes String(type) for the missing label, so blockLabel's
    // own `meta.label || meta.type` arm never actually fires — every UnitType is a non-empty
    // string. Pinned here rather than dropped: the `||` is what keeps THIS assertion true if
    // units.ts's fallback ever goes back to an empty label.
    const unknown = 'notAUnit' as UnitType;
    expect(unitMeta(unknown).label).toBe('notAUnit');
    expect(blockLabel(entry({ atTick: 0, col: lane0, unitType: unknown, count: 2 }))).toBe('notAUnit\u00d72');
  });
});

describe('gridStepSec / isMajorSecond', () => {
  it('steps 1s when zoomed in, 2s in the middle, 5s when zoomed out', () => {
    expect(gridStepSec(400)).toBe(1);
    expect(gridStepSec(120)).toBe(1);
    expect(gridStepSec(119)).toBe(2);
    expect(gridStepSec(50)).toBe(2);
    expect(gridStepSec(49)).toBe(5);
    expect(gridStepSec(12)).toBe(5);
  });

  it('marks every fifth step as major', () => {
    expect(isMajorSecond(0, 2)).toBe(true);
    expect(isMajorSecond(10, 2)).toBe(true);
    expect(isMajorSecond(8, 2)).toBe(false);
    expect(isMajorSecond(25, 5)).toBe(true);
  });
});

describe('visibleSecondRange', () => {
  it('starts at 0 when unscrolled (time never runs negative)', () => {
    expect(visibleSecondRange(PPS, 0, 800).startSec).toBe(0);
  });

  it('covers the seconds between the gutter and the right edge', () => {
    const { startSec, endSec } = visibleSecondRange(PPS, 0, GUTTER_W + PPS * 4);
    expect(startSec).toBe(0);
    expect(endSec).toBe(4);
  });

  it('advances with pan', () => {
    const { startSec } = visibleSecondRange(PPS, PPS * 3, 800);
    expect(startSec).toBe(3);
  });

  it('brackets the gutter tick: startSec never overshoots what is on screen', () => {
    const scrollX = PPS * 2.5;
    const { startSec } = visibleSecondRange(PPS, scrollX, 800);
    expect(startSec).toBe(2); // floor, so the partially-visible 2s line still gets drawn
    expect(tickToX(startSec * TICK_RATE, PPS, scrollX)).toBeLessThanOrEqual(GUTTER_W);
  });
});

describe('snapAtTick', () => {
  it('snaps to the 0.1s grid', () => {
    expect(SNAP_TICKS).toBe(3);
    expect(snapAtTick(0, 4)).toBe(3);
    expect(snapAtTick(0, 5)).toBe(6);
    expect(snapAtTick(30, 0)).toBe(30);
  });

  it('clamps at 0 rather than letting a drag push a wave before the level starts', () => {
    expect(snapAtTick(0, -100)).toBe(0);
    expect(snapAtTick(6, -6)).toBe(0);
  });

  it('is relative to the tick the drag started from, not the current one', () => {
    expect(snapAtTick(90, 30)).toBe(120);
  });
});

describe('zoomAround', () => {
  it('zooms in on a negative deltaY and out on a positive one', () => {
    expect(zoomAround(100, 0, 400, -1).pxPerSec).toBeCloseTo(115);
    expect(zoomAround(100, 0, 400, 1).pxPerSec).toBeCloseTo(100 / 1.15);
  });

  it('keeps the tick under the cursor stationary', () => {
    const x = 400;
    const before = xToTick(x, 100, 500);
    const z = zoomAround(100, 500, x, -1);
    expect(xToTick(x, z.pxPerSec, z.scrollX)).toBeCloseTo(before);
  });

  it('clamps the zoom range at both ends', () => {
    expect(zoomAround(400, 0, 400, -1).pxPerSec).toBe(400);
    expect(zoomAround(12, 0, 400, 1).pxPerSec).toBe(12);
  });

  it('never leaves a negative scroll, even zooming out at the very start', () => {
    // Zooming out at x just right of the gutter would put scrollX below 0 unclamped.
    expect(zoomAround(400, 0, GUTTER_W + 1, 1).scrollX).toBe(0);
  });
});

describe('panBy', () => {
  it('adds both wheel axes to the horizontal scroll', () => {
    expect(panBy(100, 30, 0)).toBe(130);
    expect(panBy(100, 0, 30)).toBe(130);
    expect(panBy(100, 10, 20)).toBe(130);
  });

  it('clamps at 0 so the timeline cannot be panned before tick 0', () => {
    expect(panBy(10, -50, 0)).toBe(0);
  });
});

describe('the palette', () => {
  it('exposes the lane-band and selection colours the canvas half draws with', () => {
    // Cheap pin on the one piece of pure DATA in this module: the two alternating lane bands must
    // stay distinguishable, and the selection stroke must not be one of them.
    expect(C.laneA).not.toBe(C.laneB);
    expect([C.laneA, C.laneB]).not.toContain(C.sel);
  });
});
