// Toolbar buttons: tool switching, Regenerate, Clear All, Reset Cities, and the two Export/Import
// JSON pairs. Split out of index.ts (2026-08-02 pass 2).
import {
  cityExportBtn, cityImportBtn, cityJsonEl, clearTerrainBtn, exportBtn, importBtn,
  jsonEl, regenBtn, resetCitiesBtn, toolButtons,
} from '../dom';
import { cityStore, session, terrainStore, worldId } from '../editor';
import { t } from '../i18n';
import { redrawOverlay } from '../render/overlay';
import { renderAll, renderTerrain } from '../render/refresh';
import type { Tool } from '../state/session';
import { refreshSelectedCity, selectCity } from '../ui/panels';
import { cityCountLabel, setStatus, tileCountLabel } from '../ui/status';
import { setCanvasCursor } from './canvas';

/** Reloads cities from the generator and redraws — Regenerate and Reset Cities both land here. */
export function loadCitiesAndRedraw(): void {
  cityStore.loadFromSeed(worldId());
  session.selectedCityId = null;
  refreshSelectedCity();
  renderAll();
}

function setTool(next: Tool): void {
  const selectionCleared = session.setTool(next);
  for (const btn of toolButtons) btn.classList.toggle('active', btn.dataset.tool === next);
  setCanvasCursor();
  if (selectionCleared) refreshSelectedCity();
  redrawOverlay();
}

export function wireToolbar(): void {
  for (const btn of toolButtons) {
    btn.addEventListener('click', () => setTool(btn.dataset.tool as Tool));
  }

  regenBtn.addEventListener('click', () => loadCitiesAndRedraw());

  clearTerrainBtn.addEventListener('click', () => {
    terrainStore.clear();
    renderTerrain();
  });

  resetCitiesBtn.addEventListener('click', () => loadCitiesAndRedraw());

  exportBtn.addEventListener('click', () => {
    jsonEl.value = terrainStore.toJSON();
    setStatus(() => t('status.terrainExported', { tiles: tileCountLabel(terrainStore.size) }));
  });

  importBtn.addEventListener('click', () => {
    try {
      terrainStore.loadFromJSON(jsonEl.value);
      renderTerrain();
      setStatus(() => t('status.terrainImported', { tiles: tileCountLabel(terrainStore.size) }));
    } catch (err) {
      setStatus(() => t('status.importFailed', { msg: (err as Error).message }));
    }
  });

  cityExportBtn.addEventListener('click', () => {
    cityJsonEl.value = cityStore.toJSON();
    setStatus(() => t('status.citiesExported', { cities: cityCountLabel(cityStore.nodes.length) }));
  });

  cityImportBtn.addEventListener('click', () => {
    try {
      cityStore.loadFromJSON(cityJsonEl.value);
      selectCity(null);
      renderAll();
      setStatus(() => t('status.citiesImported', { cities: cityCountLabel(cityStore.nodes.length) }));
    } catch (err) {
      setStatus(() => t('status.importFailed', { msg: (err as Error).message }));
    }
  });
}
