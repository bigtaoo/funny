import { describe, expect, it } from 'vitest';
import { proceduralTile, rasterizeMapEdits } from '../src/slg';

describe('rasterizeMapEdits', () => {
  const worldId = 'rasterize-test';

  it('returns no diffs when there are no terrain tiles/cities', () => {
    expect(rasterizeMapEdits(worldId, [], [])).toEqual([]);
  });

  it('rasterizes painted mountain/river tiles into obstacle tiles', () => {
    const tiles: { x: number; y: number; type: 'mountain' }[] = [];
    for (let x = 100; x <= 110; x++) tiles.push({ x, y: 100, type: 'mountain' });
    const diffs = rasterizeMapEdits(worldId, tiles, []);
    expect(diffs.length).toBeGreaterThan(0);
    for (const d of diffs) {
      expect(d.type).toBe('obstacle');
      expect(d.level).toBe(1);
      expect(d.resType).toBeUndefined();
    }
    // A tile that was never painted must not appear.
    expect(diffs.some((d) => d.x === 100 && d.y === 400)).toBe(false);
  });

  it('ignores out-of-bounds painted tiles', () => {
    expect(rasterizeMapEdits(worldId, [{ x: -1, y: 5, type: 'river' }], [])).toEqual([]);
  });

  it('rasterizes a dragged city into its footprint, overriding whatever terrain is there', () => {
    const diffs = rasterizeMapEdits(worldId, [], [{ x: 200, y: 200, level: 5, footprint: 3, kind: 'garrison' }]);
    expect(diffs.length).toBe(9); // 3x3 footprint, assuming (200,200) region isn't already familyKeep-lvl5 by chance
    for (const d of diffs) {
      expect(d.type).toBe('familyKeep');
      expect(d.level).toBe(5);
    }
  });

  it('worldCenter kind rasterizes to type "center" with no resType', () => {
    const diffs = rasterizeMapEdits(worldId, [], [{ x: 50, y: 50, level: 10, footprint: 1, kind: 'worldCenter' }]);
    expect(diffs).toEqual([{ x: 50, y: 50, type: 'center', level: 10 }]);
  });

  it('city footprint takes precedence over an overlapping painted tile', () => {
    const diffs = rasterizeMapEdits(
      worldId,
      [{ x: 300, y: 305, type: 'river' }],
      [{ x: 300, y: 305, level: 8, footprint: 3, kind: 'capital' }],
    );
    const center = diffs.find((d) => d.x === 300 && d.y === 305);
    expect(center?.type).toBe('familyKeep');
    expect(center?.level).toBe(8);
  });

  it('omits tiles where the rasterized result matches the procedural baseline', () => {
    // A 1-tile-footprint city placed with a level matching the baseline's own level/type should not appear.
    const base = proceduralTile(worldId, 250, 250);
    const diffs = rasterizeMapEdits(worldId, [], [
      { x: 250, y: 250, level: base.level, footprint: 1, kind: base.type === 'center' ? 'worldCenter' : 'garrison' },
    ]);
    if (base.type === 'familyKeep' || base.type === 'center') {
      expect(diffs.find((d) => d.x === 250 && d.y === 250)).toBeUndefined();
    }
  });
});
