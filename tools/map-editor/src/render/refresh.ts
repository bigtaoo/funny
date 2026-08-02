// The two redraw entry points every handler calls, plus the animation-frame coalescing that keeps
// a brush drag cheap. Split out of index.ts (2026-08-02 pass 2).
import { worldId } from '../editor';
import type { TilePoint } from '../state/terrainGrid';
import { renderBaseMap } from './baseMap';
import { refreshCitySprites } from './citySprites';
import { redrawOverlay } from './overlay';

/** Ground tiles only — what a brush stroke changes. */
export function renderTerrain(): void {
  renderBaseMap(worldId());
}

/** Everything: ground, city sprites, overlay chrome. For seed / zoom / city-position changes. */
export function renderAll(hoverTile?: TilePoint): void {
  renderBaseMap(worldId());
  refreshCitySprites();
  redrawOverlay(hoverTile);
}

/**
 * Coalesces render requests fired from high-frequency events (mousemove during a drag) down to at
 * most one render per animation frame — without this, a stroke's cost scaled with raw mouse-event
 * rate (which can far exceed the display's refresh rate) instead of frame rate.
 */
let renderScheduled = false;
let pendingBaseRender = false;
let pendingHoverTile: TilePoint | undefined;

export function scheduleRender(opts: { base: boolean; hover?: TilePoint }): void {
  if (opts.base) pendingBaseRender = true;
  pendingHoverTile = opts.hover;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (pendingBaseRender) {
      renderTerrain();
      pendingBaseRender = false;
    }
    redrawOverlay(pendingHoverTile);
  });
}
