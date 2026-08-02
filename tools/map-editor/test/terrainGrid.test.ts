// TerrainGridStore — the brush's data model (DESIGN.md §6.1/§6.2). Every assertion here is about
// state the user can lose: which tiles a stroke actually stamped, and whether an exported/imported
// JSON round-trip preserves the grid (including the retired vector-path format the editor still
// migrates on load).
import { describe, expect, it } from 'vitest';
import { SLG_MAP_H, SLG_MAP_W, TERRAIN_BAND_WIDTH_MAX, TERRAIN_BAND_WIDTH_MIN } from '@nw/shared/slg';
import { randomDefaultWidth, TerrainGridStore, type TerrainKind } from '../src/state/terrainGrid';

/** Sorted "x:y" list — set iteration order is insertion order, which is not what we mean to assert. */
function keys(store: TerrainGridStore): string[] {
  return [...store.cells.keys()].sort();
}

describe('TerrainGridStore.paintCircle', () => {
  it('stamps a single tile at diameter 1', () => {
    const s = new TerrainGridStore();
    s.paintCircle(10, 10, 'river', 1);
    expect(keys(s)).toEqual(['10:10']);
    expect(s.cells.get('10:10')).toBe('river');
  });

  it('stamps a disc, not the bounding box — corners of the square are excluded', () => {
    const s = new TerrainGridStore();
    s.paintCircle(10, 10, 'mountain', 4); // radius 2
    expect(s.cells.has('10:8')).toBe(true); // on-axis, distance 2 <= r
    expect(s.cells.has('8:8')).toBe(false); // corner, distance 2.83 > r
    expect(s.size).toBe(13); // the classic radius-2 disc
  });

  it('repainting the same tiles with another kind overwrites rather than accumulating', () => {
    const s = new TerrainGridStore();
    s.paintCircle(20, 20, 'river', 3);
    const afterFirst = s.size;
    s.paintCircle(20, 20, 'mountain', 3);
    expect(s.size).toBe(afterFirst);
    expect(new Set(s.cells.values())).toEqual(new Set(['mountain']));
  });

  it('clips to the map instead of writing negative or out-of-range coordinates', () => {
    const s = new TerrainGridStore();
    s.paintCircle(0, 0, 'river', 6);
    s.paintCircle(SLG_MAP_W - 1, SLG_MAP_H - 1, 'river', 6);
    for (const key of keys(s)) {
      const [x, y] = key.split(':').map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(SLG_MAP_W);
      expect(y).toBeLessThan(SLG_MAP_H);
    }
  });
});

describe('TerrainGridStore.eraseCircle', () => {
  it('removes only the tiles under the brush', () => {
    const s = new TerrainGridStore();
    s.paintCircle(30, 30, 'river', 9);
    const before = s.size;
    s.eraseCircle(30, 30, 3);
    expect(s.size).toBeLessThan(before);
    expect(s.cells.has('30:30')).toBe(false);
    expect(s.cells.has('30:26')).toBe(true); // outside the eraser, still painted
  });

  it('erasing empty space is a no-op', () => {
    const s = new TerrainGridStore();
    s.eraseCircle(50, 50, 5);
    expect(s.size).toBe(0);
  });
});

describe('TerrainGridStore.strokeCircle', () => {
  // The whole reason strokeCircle exists: a fast drag samples mousemove sparsely, and stamping only
  // at the samples leaves visible holes in the band. Interpolation must close them.
  it('leaves no gap along a long drag — every tile on the segment is painted', () => {
    const s = new TerrainGridStore();
    s.strokeCircle({ x: 100, y: 100 }, { x: 160, y: 100 }, 'river', 1);
    for (let x = 100; x <= 160; x++) expect(s.cells.has(`${x}:100`)).toBe(true);
  });

  it('is denser than stamping the endpoints alone', () => {
    const stroked = new TerrainGridStore();
    stroked.strokeCircle({ x: 100, y: 100 }, { x: 140, y: 130 }, 'mountain', 5);
    const stamped = new TerrainGridStore();
    stamped.paintCircle(100, 100, 'mountain', 5);
    stamped.paintCircle(140, 130, 'mountain', 5);
    expect(stroked.size).toBeGreaterThan(stamped.size);
  });

  it('erases along the segment when kind is null', () => {
    const s = new TerrainGridStore();
    s.paintCircle(100, 100, 'river', 3);
    s.strokeCircle({ x: 100, y: 100 }, { x: 130, y: 100 }, 'river', 3);
    s.strokeCircle({ x: 100, y: 100 }, { x: 130, y: 100 }, null, 3);
    expect(s.size).toBe(0);
  });

  it('a zero-length stroke still stamps once (a plain click paints)', () => {
    const s = new TerrainGridStore();
    s.strokeCircle({ x: 7, y: 7 }, { x: 7, y: 7 }, 'bridge', 1);
    expect(keys(s)).toEqual(['7:7']);
  });
});

describe('TerrainGridStore JSON round-trip', () => {
  it('export → import reproduces the grid exactly', () => {
    const a = new TerrainGridStore();
    a.paintCircle(200, 200, 'river', 7);
    a.paintCircle(210, 205, 'mountain', 5);
    a.paintCircle(203, 202, 'bridge', 2);

    const b = new TerrainGridStore();
    b.loadFromJSON(a.toJSON());
    expect(keys(b)).toEqual(keys(a));
    for (const key of keys(a)) expect(b.cells.get(key)).toBe(a.cells.get(key));
  });

  it('import replaces the existing grid rather than merging into it', () => {
    const s = new TerrainGridStore();
    s.paintCircle(300, 300, 'river', 5);
    s.loadFromJSON(JSON.stringify([{ x: 1, y: 2, type: 'mountain' }]));
    expect(keys(s)).toEqual(['1:2']);
  });

  it('toTileInputs emits numeric coordinates, not the "x:y" key strings', () => {
    const s = new TerrainGridStore();
    s.paintCircle(400, 401, 'plankway', 1);
    expect(s.toTileInputs()).toEqual([{ x: 400, y: 401, type: 'plankway' }]);
  });

  it('accepts every paintable kind', () => {
    const kinds: TerrainKind[] = ['river', 'mountain', 'neutral', 'bridge', 'plankway'];
    const s = new TerrainGridStore();
    s.loadFromJSON(JSON.stringify(kinds.map((type, i) => ({ x: i, y: 0, type }))));
    expect(s.toTileInputs().map((t) => t.type)).toEqual(kinds);
  });

  it('rejects malformed input instead of silently importing a broken grid', () => {
    const s = new TerrainGridStore();
    expect(() => s.loadFromJSON('{}')).toThrow(/expected an array/);
    expect(() => s.loadFromJSON('[{"x":1,"y":1,"type":"lava"}]')).toThrow(/invalid terrain type/);
    expect(() => s.loadFromJSON('[{"x":"1","y":1,"type":"river"}]')).toThrow(/numeric x\/y/);
  });
});

describe('TerrainGridStore legacy vector-path migration', () => {
  // JSON exported before the 2026-07-06 grid-brush rewrite is {type, points[], width} polylines.
  // Dropping it on load would silently discard a designer's saved work.
  it('rasterizes a multi-point polyline into a continuous band', () => {
    const s = new TerrainGridStore();
    s.loadFromJSON(
      JSON.stringify([{ type: 'river', width: 3, points: [{ x: 50, y: 50 }, { x: 70, y: 50 }, { x: 70, y: 65 }] }]),
    );
    expect(s.cells.get('50:50')).toBe('river');
    expect(s.cells.get('60:50')).toBe('river'); // mid-segment — only exists if the path was stroked
    expect(s.cells.get('70:60')).toBe('river'); // second segment
  });

  it('rasterizes a degenerate single-point path as one brush stamp', () => {
    const s = new TerrainGridStore();
    s.loadFromJSON(JSON.stringify([{ type: 'mountain', width: 1, points: [{ x: 80, y: 80 }] }]));
    expect(keys(s)).toEqual(['80:80']);
  });

  it('tolerates an empty points list', () => {
    const s = new TerrainGridStore();
    s.loadFromJSON(JSON.stringify([{ type: 'mountain', width: 5, points: [] }]));
    expect(s.size).toBe(0);
  });

  it('mixes legacy paths and current per-tile entries in one file', () => {
    const s = new TerrainGridStore();
    s.loadFromJSON(
      JSON.stringify([
        { type: 'river', width: 1, points: [{ x: 10, y: 10 }, { x: 12, y: 10 }] },
        { x: 90, y: 90, type: 'mountain' },
      ]),
    );
    expect(s.cells.get('11:10')).toBe('river');
    expect(s.cells.get('90:90')).toBe('mountain');
  });
});

describe('TerrainGridStore.clear', () => {
  it('empties the grid', () => {
    const s = new TerrainGridStore();
    s.paintCircle(5, 5, 'river', 9);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.toJSON()).toBe('[]');
  });
});

describe('randomDefaultWidth', () => {
  it('always lands in the ADR-034 procedural band-width range', () => {
    for (let i = 0; i < 200; i++) {
      const w = randomDefaultWidth();
      expect(w).toBeGreaterThanOrEqual(TERRAIN_BAND_WIDTH_MIN);
      expect(w).toBeLessThanOrEqual(TERRAIN_BAND_WIDTH_MAX);
      expect(Number.isInteger(w)).toBe(true);
    }
  });
});
