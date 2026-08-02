// Map Editor entry point (DESIGN.md §6): boot order and nothing else.
//
// The editor is a PixiJS isometric viewport rendering the same atlases/projection as the game
// client's WorldMapRenderer (§6.3 art-parity requirement), plus a river/mountain grid brush, city
// drag, and publish-to-server (§8, §24 admin map-template API). Painting stamps tiles directly into
// a persistent terrain grid (state/terrainGrid.ts) — no vector layer to reconstruct. River/mountain
// tiles and city positions are rasterized (mapEdit.ts's rasterizeMapEdits) into a tile diff both for
// the live WYSIWYG preview (baked into the base layer on every commit) and for publishing — the
// exact same function drives both, so "what you see" and "what gets published" can never drift apart.
//
// Where things live (2026-08-02 split, DESIGN.md §8):
//   state/    Camera, EditorSession, TerrainGridStore, CityStore — no DOM, no PIXI, unit-tested
//   editor.ts the app-wide instances of the above (the shared store this file used to hold as `let`s)
//   stage.ts  the PIXI.Application and its layer stack;  dom.ts  every element ref
//   render/   what gets drawn from that state
//   ui/       what gets written into the panels
//   input/    what events do to the state
import { widthInput } from './dom';
import { camera } from './editor';
import { setCanvasCursor, wireCanvasInput } from './input/canvas';
import { loadCitiesAndRedraw, wireToolbar } from './input/toolbar';
import { wireViewport } from './input/viewport';
import { loadBuildingAtlas } from './render/buildingAtlasLoader';
import { loadCityAtlas } from './render/cityAtlasLoader';
import { loadResAtlas } from './render/resAtlasLoader';
import { loadTerrainAtlas } from './render/terrainAtlasLoader';
import { randomDefaultWidth } from './state/terrainGrid';
import { applyDynamicI18n, applyStaticI18n, wireLanguageToggle } from './ui/i18nApply';
import { renderLegend } from './ui/panels';
import { wirePublishPanel } from './ui/publish';

widthInput.value = String(randomDefaultWidth());

// wireViewport() goes first: it installs camera.onChange, which is what syncs worldLayer.position —
// so the centerOnMap() below has somewhere to land.
wireViewport();
wireToolbar();
wireCanvasInput();
wirePublishPanel();
wireLanguageToggle();

applyStaticI18n();
applyDynamicI18n();
renderLegend();
setCanvasCursor(); // matches the default 'pan' tool
camera.centerOnMap();

// First draw waits for the atlases: drawEditorTile falls back to flat colour fills without them, so
// rendering earlier would flash a colour-block map before the real art lands.
Promise.allSettled([loadTerrainAtlas(), loadResAtlas(), loadBuildingAtlas(), loadCityAtlas()]).then(() => {
  loadCitiesAndRedraw();
});
