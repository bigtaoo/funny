// TimelinePanel.ts's pure tick<->pixel coordinate transforms and block hit-testing (wave-entry
// blocks laid out on attack-lane rows, DESIGN.md §9). Extracted as free functions taking
// `pxPerSec`/`scrollX` explicitly (behavior unchanged — every call site delegates), since the
// class itself builds a real `<canvas>`/ResizeObserver/window listeners in its constructor and
// has no headless-DOM harness — see vitest.config.ts's scope note.
import { describe, it, expect } from 'vitest';
import { ATTACK_LANES } from '@nw/engine/config';
import { TICK_RATE } from '@nw/engine/math/fixed';
import { UnitType } from '@nw/engine/types';
import type { WaveEntry } from '@nw/engine/campaign/LevelDefinition';
import { tickToX, xToTick, laneIndex, yToLaneIndex, entryEndTick, hitTest, GUTTER_W, RULER_H, LANE_H } from '../src/timeline/TimelinePanel';

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
