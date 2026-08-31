// selectedPlot — which cells the world-map selection highlight covers (2026-08-30).
//
// Before this, the highlight was always the single tapped cell, so selecting a base or a wild city
// drew a one-tile diamond somewhere inside a 3×3..9×9 building. These pin the two things that fix
// depends on: the base ANCHOR is recovered from the tile cache (WorldTileView has no anchor field),
// and a city's size comes from its node list rather than from the tapped cell.

import { describe, it, expect } from 'vitest';
import { BASE_FOOTPRINT } from '@nw/shared';
import { selectedPlot } from '../src/scenes/worldmap/logic/selectionFootprint';
import type { WorldMapContext } from '../src/scenes/worldmap/WorldMapContext';
import type { WorldCityNodeView, WorldTileView } from '../src/net/WorldApiClient';

/** A ctx stub with just the tile cache selectedPlot reads. */
function ctxWith(tiles: { x: number; y: number; type: WorldTileView['type'] }[]): WorldMapContext {
  const tileCache = new Map<string, WorldTileView>();
  for (const t of tiles) tileCache.set(`${t.x}:${t.y}`, { x: t.x, y: t.y, type: t.type, level: 1 });
  return { tileCache } as unknown as WorldMapContext;
}

/** All 9 cells of a base anchored at (ax, ay), as the server writes them (every cell type:'base'). */
function baseBlock(ax: number, ay: number): { x: number; y: number; type: WorldTileView['type'] }[] {
  const out: { x: number; y: number; type: WorldTileView['type'] }[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push({ x: ax + dx, y: ay + dy, type: 'base' });
  return out;
}

const NO_CITIES: WorldCityNodeView[] = [];

describe('selectedPlot — plain land', () => {
  it('an ordinary tile selects only itself', () => {
    const ctx = ctxWith([{ x: 4, y: 7, type: 'resource' }]);
    expect(selectedPlot(ctx, 4, 7, NO_CITIES)).toEqual({ ax: 4, ay: 7, size: 1 });
  });

  it('an uncached tile (outside vision) selects only itself rather than guessing', () => {
    expect(selectedPlot(ctxWith([]), 4, 7, NO_CITIES)).toEqual({ ax: 4, ay: 7, size: 1 });
  });
});

describe('selectedPlot — player base (ADR-025 3×3)', () => {
  it('tapping the anchor selects the whole 3×3 block', () => {
    const ctx = ctxWith(baseBlock(10, 10));
    expect(selectedPlot(ctx, 10, 10, NO_CITIES)).toEqual({ ax: 10, ay: 10, size: BASE_FOOTPRINT });
  });

  it('tapping a CORNER cell resolves back to the same anchor, not to the corner', () => {
    // The regression this guards: the highlight used to sit on whichever of the 9 cells was tapped.
    const ctx = ctxWith(baseBlock(10, 10));
    expect(selectedPlot(ctx, 9, 9, NO_CITIES)).toEqual({ ax: 10, ay: 10, size: BASE_FOOTPRINT });
    expect(selectedPlot(ctx, 11, 11, NO_CITIES)).toEqual({ ax: 10, ay: 10, size: BASE_FOOTPRINT });
  });

  it('falls back to the single cell when the footprint is only half-cached (vision gap)', () => {
    // Only the tapped cell is known to be base ground — no candidate anchor has 4 base neighbours,
    // so outlining a 3×3 would be a guess about land we cannot see.
    const ctx = ctxWith([{ x: 10, y: 10, type: 'base' }]);
    expect(selectedPlot(ctx, 10, 10, NO_CITIES)).toEqual({ ax: 10, ay: 10, size: 1 });
  });
});

describe('selectedPlot — wild city (ADR-034 §3, 3×3..9×9)', () => {
  const city = { x: 40, y: 40, footprint: 7, kind: 'capital' } as WorldCityNodeView;

  it('tapping city ground selects the whole plot at the node\'s own footprint', () => {
    const ctx = ctxWith([{ x: 43, y: 40, type: 'familyKeep' }]);
    expect(selectedPlot(ctx, 43, 40, [city])).toEqual({ ax: 40, ay: 40, size: 7 });
  });

  it('the world-centre mega-city rasterizes as type "center" and is recognised too', () => {
    const centre = { x: 100, y: 100, footprint: 9, kind: 'worldCenter' } as WorldCityNodeView;
    const ctx = ctxWith([{ x: 96, y: 100, type: 'center' }]);
    expect(selectedPlot(ctx, 96, 100, [centre])).toEqual({ ax: 100, ay: 100, size: 9 });
  });

  it('city-typed ground with no covering node falls back to the single cell', () => {
    const ctx = ctxWith([{ x: 43, y: 40, type: 'familyKeep' }]);
    expect(selectedPlot(ctx, 43, 40, NO_CITIES)).toEqual({ ax: 43, ay: 40, size: 1 });
  });
});
