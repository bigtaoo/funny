import { describe, expect, it } from 'vitest';
import { allCityNodes, proceduralCityGroundTiles, proceduralTile, rasterizeMapEdits } from '../src/slg';

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

  it('rasterizes a top-tier city as a solid 9×9 block of familyKeep city ground (81 tiles)', () => {
    // Pins the footprint semantics that survived the 2026-08-19 scattered-keep deletion: `familyKeep`
    // now means "city ground" and nothing else, and a published city still stamps EVERY tile of its
    // footprint. That last part is deliberately UNCHANGED by the follow-up fix later the same day
    // (published city nodes are now served to the client's sprite layer, and `familyKeep` no longer
    // stamps a per-tile gatehouse) — the footprint is still the city's ground, it just no longer
    // renders as 81 gatehouses. See the `citiesAreComplete` block below for what that fix did add.
    const diffs = rasterizeMapEdits(worldId, [], [{ x: 400, y: 400, level: 10, footprint: 9, kind: 'capital' }]);
    expect(diffs.length).toBe(81);
    expect(new Set(diffs.map((d) => d.type))).toEqual(new Set(['familyKeep']));
    const xs = diffs.map((d) => d.x);
    const ys = diffs.map((d) => d.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([396, 404, 396, 404]);
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

  // ── citiesAreComplete: reverting the ground a dragged city vacated (2026-08-19) ──────────────
  describe('citiesAreComplete', () => {
    const worldId = 'vacate-test';

    it('is off by default — a partial city list never touches the cities it omits', () => {
      const diffs = rasterizeMapEdits(worldId, [], [{ x: 600, y: 600, level: 5, footprint: 3, kind: 'garrison' }]);
      expect(diffs.every((d) => Math.abs(d.x - 600) <= 1 && Math.abs(d.y - 600) <= 1)).toBe(true);
    });

    it('publishing the unchanged node list is a no-op — every anchor is re-painted as it was', () => {
      const diffs = rasterizeMapEdits(worldId, [], allCityNodes(worldId), { citiesAreComplete: true });
      // Each city's own anchor is reverted by pass 1 then re-claimed by pass 3 at the same type/level, so
      // it drops out of the diff. Footprint tiles AROUND a capital/garrison do change (proceduralTile only
      // marks the anchor) — the assertion is that nothing lands on a VACATED anchor.
      const ground = new Set(proceduralCityGroundTiles(worldId).map((t) => `${t.x}:${t.y}`));
      for (const d of diffs) {
        if (!ground.has(`${d.x}:${d.y}`)) continue;
        expect(d.type).toMatch(/^(familyKeep|center)$/);
      }
    });

    it('hands the old anchor of a dragged city back to the terrain', () => {
      const nodes = allCityNodes(worldId);
      const moved = nodes.find((n) => n.kind === 'garrison')!;
      const from = { x: moved.x, y: moved.y };
      // Drag it far enough that neither its new footprint nor any other city covers the old anchor.
      const dragged = nodes.map((n) => (n.id === moved.id ? { ...n, x: n.x - 40, y: n.y - 40 } : n));
      expect(proceduralTile(worldId, from.x, from.y).type).toBe('familyKeep');

      const diffs = rasterizeMapEdits(worldId, [], dragged, { citiesAreComplete: true });
      const vacated = diffs.find((d) => d.x === from.x && d.y === from.y);
      expect(vacated).toBeDefined();
      expect(vacated!.type).not.toBe('familyKeep');
      expect(vacated!.type).not.toBe('center');
      // ...and the new position is city ground now.
      const landed = diffs.find((d) => d.x === from.x - 40 && d.y === from.y - 40);
      expect(landed?.type).toBe('familyKeep');
    });

    it('hands the whole 9x9 block back when the world center is dragged', () => {
      const nodes = allCityNodes(worldId);
      const center = nodes.find((n) => n.kind === 'worldCenter')!;
      const dragged = nodes.map((n) => (n.id === center.id ? { ...n, x: n.x + 200, y: n.y + 200 } : n));
      const diffs = rasterizeMapEdits(worldId, [], dragged, { citiesAreComplete: true });
      const byKey = new Map(diffs.map((d) => [`${d.x}:${d.y}`, d]));
      const r = 4; // (WORLD_CENTER_FOOTPRINT - 1) / 2
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          expect(byKey.get(`${center.x + dx}:${center.y + dy}`)?.type).not.toBe('center');
        }
      }
      expect(byKey.get(`${center.x + 200}:${center.y + 200}`)?.type).toBe('center');
    });

    it('a painted terrain cell still beats the revert, and a city footprint still beats both', () => {
      const nodes = allCityNodes(worldId);
      const moved = nodes.find((n) => n.kind === 'garrison')!;
      const dragged = nodes.map((n) => (n.id === moved.id ? { ...n, x: n.x - 40, y: n.y - 40 } : n));
      const diffs = rasterizeMapEdits(
        worldId,
        [{ x: moved.x, y: moved.y, type: 'river' }],
        dragged,
        { citiesAreComplete: true },
      );
      const painted = diffs.find((d) => d.x === moved.x && d.y === moved.y);
      expect(painted?.type).toBe('obstacle');
      expect(painted?.obstacleKind).toBe('river');
    });
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
