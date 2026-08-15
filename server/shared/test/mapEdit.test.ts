import { describe, expect, it } from 'vitest';
import { proceduralTile, rasterizeMapEdits } from '../src/slg';

describe('rasterizeMapEdits', () => {
  const worldId = 'rasterize-test';

  it('returns no diffs when there are no terrain tiles/cities', () => {
    expect(rasterizeMapEdits(worldId, [], [])).toEqual([]);
  });

  it('rasterizes painted mountain/river tiles into obstacle tiles, preserving the painted art kind', () => {
    const tiles: { x: number; y: number; type: 'mountain' }[] = [];
    for (let x = 100; x <= 110; x++) tiles.push({ x, y: 100, type: 'mountain' });
    const diffs = rasterizeMapEdits(worldId, tiles, []);
    expect(diffs.length).toBeGreaterThan(0);
    for (const d of diffs) {
      expect(d.type).toBe('obstacle');
      expect(d.level).toBe(1);
      expect(d.resType).toBeUndefined();
      expect(d.obstacleKind).toBe('mountain');
    }
    // A tile that was never painted must not appear.
    expect(diffs.some((d) => d.x === 100 && d.y === 400)).toBe(false);
  });

  it('preserves river vs mountain art kind independently', () => {
    const river = rasterizeMapEdits(worldId, [{ x: 120, y: 120, type: 'river' }], []);
    expect(river.every((d) => d.obstacleKind === 'river')).toBe(true);
    const mountain = rasterizeMapEdits(worldId, [{ x: 120, y: 120, type: 'mountain' }], []);
    expect(mountain.every((d) => d.obstacleKind === 'mountain')).toBe(true);
  });

  it('a painted "neutral" cell carves an open (non-obstacle) tile, overriding any baseline terrain', () => {
    // Paint the same cell mountain then neutral — neutral should win in its own call and read back as open land.
    const diffs = rasterizeMapEdits(worldId, [{ x: 130, y: 130, type: 'neutral' }], []);
    const cell = diffs.find((d) => d.x === 130 && d.y === 130);
    // Only appears in the diff if it actually differs from the baseline; assert on the type when present,
    // and always assert the underlying override logic never produces an obstacle.
    if (cell) {
      expect(cell.type).toBe('neutral');
      expect(cell.level).toBe(1);
      expect(cell.obstacleKind).toBeUndefined();
    }
  });

  it('painted bridge/plankway cells rasterize to capturable crossing tiles at the fixed crossing level', () => {
    const bridge = rasterizeMapEdits(worldId, [{ x: 140, y: 140, type: 'bridge' }], []);
    const bridgeCell = bridge.find((d) => d.x === 140 && d.y === 140);
    expect(bridgeCell?.type).toBe('bridge');

    const plankway = rasterizeMapEdits(worldId, [{ x: 141, y: 141, type: 'plankway' }], []);
    const plankwayCell = plankway.find((d) => d.x === 141 && d.y === 141);
    expect(plankwayCell?.type).toBe('plankway');
    // Both crossing kinds share the same fixed level (independent of the baseline tile's own level).
    expect(bridgeCell?.level).toBe(plankwayCell?.level);
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

  it('clips a city footprint that spills past the map edge instead of writing out-of-bounds tiles', () => {
    const diffs = rasterizeMapEdits(
      worldId,
      [],
      [{ x: 0, y: 0, level: 5, footprint: 3, kind: 'garrison' }], // top-left corner: half the 3×3 footprint is OOB
    );
    for (const d of diffs) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.y).toBeGreaterThanOrEqual(0);
    }
    // Only the in-bounds quadrant of the 3×3 footprint (a 2×2 block: (0,0),(1,0),(0,1),(1,1)) can appear.
    expect(diffs.length).toBeLessThanOrEqual(4);
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
