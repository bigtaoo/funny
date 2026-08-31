// Which cells the selected-tile highlight should cover (2026-08-30).
//
// A player base is an indivisible 3×3 block (ADR-025) and a wild city occupies its whole N×N plot
// (ADR-034 §3, 3×3 up to 9×9) — but the selection highlight used to outline only the single tapped
// cell. On a city that renders as a small diamond floating somewhere inside a much larger building,
// which reads as a misaligned marker rather than "you selected this city": the highlight and the
// thing it highlights visibly disagree. Selecting the whole plot instead makes the highlight say
// exactly what every rule downstream already treats as one unit — an attack targets the whole
// footprint, connectivity is checked at its outer perimeter, and a corner can't be taken on its own.
//
// The union of an isometric N×N block IS itself a diamond N tile-widths across (that's what the
// projection does to an axis-aligned square), so the caller draws ONE diamond centred on the plot
// anchor rather than N² per-cell outlines — no clutter, and the outline lands exactly on the plot
// edge the tile art already draws.
import { BASE_FOOTPRINT, cityNodeCovering } from '@nw/shared';
import type { WorldCityNodeView } from '../../../net/WorldApiClient';
import type { WorldMapContext } from '../WorldMapContext';

/** An isometric plot: a `size`×`size` block of tiles centred on (ax, ay). size 1 = a plain tile. */
export interface SelectedPlot {
  ax: number;
  ay: number;
  size: number;
}

/** City-ground tile types — what rasterizeMapEdits writes across a city's footprint (shared mapEdit.ts
 *  `_cityTileType`): the world-centre mega-city is 'center', every other city node is 'familyKeep'. */
const CITY_GROUND_TYPES = new Set(['familyKeep', 'center']);

/**
 * The plot the highlight should cover for a tap at (tx, ty): the tapped cell's base footprint, its
 * city plot, or — for ordinary land — just the cell itself.
 *
 * A base's anchor is recovered the same way {@link attackFootprintCells} and
 * WorldMapRendererPool.isBaseAnchor do it (WorldTileView carries no anchor field): scan the tapped
 * cell's own 3×3 neighbourhood for the cell whose 4 neighbours are all also 'base'. The tapped cell
 * is necessarily inside that neighbourhood because a base footprint is only 3 wide. If no candidate
 * resolves (vision/cache gap at the edge of the footprint) this falls back to the single tapped cell
 * rather than guessing a wrong anchor and outlining someone else's land.
 */
export function selectedPlot(
  ctx: WorldMapContext,
  tx: number,
  ty: number,
  cityNodes: readonly WorldCityNodeView[],
): SelectedPlot {
  const tile = ctx.tileCache.get(`${tx}:${ty}`);
  if (tile?.type === 'base') {
    for (let ay = ty - 1; ay <= ty + 1; ay++) {
      for (let ax = tx - 1; ax <= tx + 1; ax++) {
        if (ctx.tileCache.get(`${ax}:${ay}`)?.type !== 'base') continue;
        const ring: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        if (ring.every(([dx, dy]) => ctx.tileCache.get(`${ax + dx}:${ay + dy}`)?.type === 'base')) {
          return { ax, ay, size: BASE_FOOTPRINT };
        }
      }
    }
    return { ax: tx, ay: ty, size: 1 };
  }
  if (tile && CITY_GROUND_TYPES.has(tile.type)) {
    const city = cityNodeCovering(cityNodes, tx, ty);
    if (city) return { ax: city.x, ay: city.y, size: city.footprint };
  }
  return { ax: tx, ay: ty, size: 1 };
}
