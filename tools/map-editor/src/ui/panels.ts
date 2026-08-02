// The right-hand inspector panels: legend swatches, the hovered-tile readout, the painted-terrain
// count and the selected-city details. Split out of index.ts (2026-08-02 pass 2).
import { CITY_COLORS_CSS, TERRAIN_LEGEND, TERRAIN_LEGEND_CSS } from '../constants';
import { cityInfoEl, cityLegendEl, legendEl, terrainTitleEl, tileInfoEl } from '../dom';
import { cityStore, session, terrainStore } from '../editor';
import { t } from '../i18n';
import type { MapEditorCityNode } from '../state/cities';
import { redrawOverlay } from '../render/overlay';
import type { EffectiveTile } from '../render/baseMap';
import type { TilePoint } from '../state/terrainGrid';
import { tileCountLabel } from './status';

export function renderLegend(): void {
  legendEl.innerHTML = TERRAIN_LEGEND
    .map((kind) => `<div class="row"><i style="background:${TERRAIN_LEGEND_CSS[kind]}"></i>${kind}</div>`)
    .join('');
  cityLegendEl.innerHTML = (Object.keys(CITY_COLORS_CSS) as MapEditorCityNode['kind'][])
    .map((k) => `<div class="row"><i style="background:${CITY_COLORS_CSS[k]}"></i>${k}</div>`)
    .join('');
}

export function renderTerrainTitle(): void {
  terrainTitleEl.textContent = t('insp.terrainTitle', { count: tileCountLabel(terrainStore.size) });
}

// ── Tile inspector ───────────────────────────────────────────────────────
export function showTileInfo(pos: TilePoint, tile: EffectiveTile): void {
  const resLine = tile.resType ? `\n${t('tile.resource')}: ${t(`resource.${tile.resType}`)}` : '';
  const typeLabel = tile.obstacleKind ? `${tile.type} (${tile.obstacleKind})` : tile.type;
  tileInfoEl.textContent = `(${pos.x}, ${pos.y})\n${t('tile.type')}: ${typeLabel}\n${t('tile.level')}: ${tile.level}${resLine}`;
  session.tileInfoShown = true;
}

/** Restores the "hover the map" hint — only while no real hover data has been shown yet, so a
 * locale toggle mid-session doesn't wipe the readout the user is looking at. */
export function refreshTileInfoHint(): void {
  if (!session.tileInfoShown) tileInfoEl.textContent = t('tile.hoverHint');
}

// ── City inspector ───────────────────────────────────────────────────────
export function cityLabel(node: MapEditorCityNode): string {
  const provLine = node.provinceIdx !== undefined ? `\n${t('city.province')}: ${node.provinceIdx}` : '';
  return (
    `${t('city.id')}: ${node.id}\n${t('city.kind')}: ${node.kind}\n${t('city.level')}: ${node.level}\n` +
    `${t('city.footprint')}: ${node.footprint}×${node.footprint}${provLine}\n${t('city.coords', { x: node.x, y: node.y })}`
  );
}

/** Selects a city (or clears the selection) and refreshes both the details panel and the overlay's
 * selection ring. */
export function selectCity(id: string | null): void {
  session.selectedCityId = id;
  refreshSelectedCity();
  redrawOverlay();
}

/** Re-renders the details panel from the current selection — used while dragging (position changes
 * live) and after a locale toggle, neither of which should touch the overlay. */
export function refreshSelectedCity(): void {
  const node = session.selectedCityId ? cityStore.get(session.selectedCityId) : undefined;
  cityInfoEl.textContent = node ? cityLabel(node) : t('city.hint');
}
