import { describe, expect, it } from 'vitest';
import { encodeRow, decodeRow, tileAtX, sliceRuns, applyEditsToRow, type TileRun } from '../src/slg';
import type { ProceduralTile } from '../src/slg/mapgen';

const neutral = (level = 1): ProceduralTile => ({ type: 'neutral', level });
const obstacle = (kind: 'river' | 'mountain'): ProceduralTile => ({ type: 'obstacle', level: 1, obstacleKind: kind });
const resource = (): ProceduralTile => ({ type: 'resource', level: 3, resType: 'ink' });

describe('encodeRow/decodeRow', () => {
  it('encodes a uniform row into a single run', () => {
    const runs = encodeRow(10, () => neutral());
    expect(runs).toEqual([{ x0: 0, x1: 9, type: 'neutral', level: 1 }]);
  });

  it('encodes distinct adjacent tiles into distinct single-cell runs', () => {
    const cells = [neutral(1), neutral(2), obstacle('river')];
    const runs = encodeRow(3, (x) => cells[x]!);
    expect(runs).toEqual([
      { x0: 0, x1: 0, type: 'neutral', level: 1 },
      { x0: 1, x1: 1, type: 'neutral', level: 2 },
      { x0: 2, x1: 2, type: 'obstacle', level: 1, obstacleKind: 'river' },
    ]);
  });

  it('round-trips a mixed row through encode → decode', () => {
    const cells: ProceduralTile[] = [
      neutral(1), neutral(1), neutral(1), obstacle('mountain'), obstacle('mountain'), resource(), neutral(1),
    ];
    const runs = encodeRow(cells.length, (x) => cells[x]!);
    expect(runs.length).toBe(4); // 3 runs of distinct tiles collapse the 7 cells, resource is its own run
    const decoded = decodeRow(runs, cells.length);
    expect(decoded).toEqual(cells);
  });

  it('resType/obstacleKind absence does not leak as an explicit undefined key (matches proceduralTile\'s own optional-field convention)', () => {
    const runs = encodeRow(1, () => neutral());
    expect(runs[0]).not.toHaveProperty('resType');
    expect(runs[0]).not.toHaveProperty('obstacleKind');
  });
});

describe('tileAtX', () => {
  const runs: TileRun[] = [
    { x0: 0, x1: 4, type: 'neutral', level: 1 },
    { x0: 5, x1: 5, type: 'obstacle', level: 1, obstacleKind: 'river' },
    { x0: 6, x1: 9, type: 'neutral', level: 1 },
  ];

  it('returns the tile whose run contains x, including exact run boundaries', () => {
    expect(tileAtX(runs, 0)).toEqual({ type: 'neutral', level: 1 });
    expect(tileAtX(runs, 4)).toEqual({ type: 'neutral', level: 1 });
    expect(tileAtX(runs, 5)).toEqual({ type: 'obstacle', level: 1, obstacleKind: 'river' });
    expect(tileAtX(runs, 9)).toEqual({ type: 'neutral', level: 1 });
  });

  it('returns undefined for an x outside every run', () => {
    expect(tileAtX(runs, 10)).toBeUndefined();
    expect(tileAtX(runs, -1)).toBeUndefined();
  });
});

describe('sliceRuns', () => {
  const runs: TileRun[] = [
    { x0: 0, x1: 9, type: 'neutral', level: 1 },
    { x0: 10, x1: 10, type: 'obstacle', level: 1, obstacleKind: 'mountain' },
    { x0: 11, x1: 19, type: 'neutral', level: 1 },
  ];

  it('splits a run straddling the bbox boundary at the boundary', () => {
    const sliced = sliceRuns(runs, 5, 12);
    expect(sliced).toEqual([
      { x0: 5, x1: 9, type: 'neutral', level: 1 },
      { x0: 10, x1: 10, type: 'obstacle', level: 1, obstacleKind: 'mountain' },
      { x0: 11, x1: 12, type: 'neutral', level: 1 },
    ]);
  });

  it('drops runs entirely outside the requested range', () => {
    expect(sliceRuns(runs, 100, 200)).toEqual([]);
  });

  it('a bbox covering the whole row returns the runs unchanged', () => {
    expect(sliceRuns(runs, 0, 19)).toEqual(runs);
  });
});

describe('applyEditsToRow', () => {
  it('applies a single-cell edit and re-encodes, merging into a neighboring identical run', () => {
    const runs = encodeRow(5, () => neutral(1));
    const edited = applyEditsToRow(runs, 5, new Map([[2, neutral(1)]])); // no-op edit (same value)
    expect(edited).toEqual([{ x0: 0, x1: 4, type: 'neutral', level: 1 }]);
  });

  it('applies a single-cell edit that splits a uniform run into three', () => {
    const runs = encodeRow(5, () => neutral(1));
    const edited = applyEditsToRow(runs, 5, new Map([[2, obstacle('river')]]));
    expect(edited).toEqual([
      { x0: 0, x1: 1, type: 'neutral', level: 1 },
      { x0: 2, x1: 2, type: 'obstacle', level: 1, obstacleKind: 'river' },
      { x0: 3, x1: 4, type: 'neutral', level: 1 },
    ]);
  });

  it('applying an edit at the row boundary does not go out of range', () => {
    const runs = encodeRow(3, () => neutral(1));
    const edited = applyEditsToRow(runs, 3, new Map([[0, obstacle('mountain')]]));
    expect(edited).toEqual([
      { x0: 0, x1: 0, type: 'obstacle', level: 1, obstacleKind: 'mountain' },
      { x0: 1, x1: 2, type: 'neutral', level: 1 },
    ]);
  });

  it('applying multiple edits that together restore uniformity re-merges into one run', () => {
    const runs = encodeRow(4, (x) => (x === 1 ? obstacle('river') : neutral(1)));
    expect(runs.length).toBe(3);
    const edited = applyEditsToRow(runs, 4, new Map([[1, neutral(1)]]));
    expect(edited).toEqual([{ x0: 0, x1: 3, type: 'neutral', level: 1 }]);
  });

  it('ignores an edit whose x is out of [0,width)', () => {
    const runs = encodeRow(3, () => neutral(1));
    const edited = applyEditsToRow(runs, 3, new Map([[99, obstacle('river')]]));
    expect(edited).toEqual([{ x0: 0, x1: 2, type: 'neutral', level: 1 }]);
  });
});
