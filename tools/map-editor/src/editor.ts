// The editor's shared state, instantiated once on module load — the store every render, UI and
// input module reads instead of the module-level `let`s the old index.ts kept in its own closure
// (DESIGN.md §8, 2026-08-02 pass 2).
//
// Same module-singleton pattern as stage.ts (PIXI layers) and dom.ts (element refs). The state
// classes themselves live under state/ and are DOM/PIXI-free so the tests construct them directly;
// this module is just the app-wide instances plus the one bit of state that lives in an input
// element rather than in a class.
import { Camera } from './state/camera';
import { CityStore } from './state/cities';
import { EditorSession } from './state/session';
import { TerrainGridStore } from './state/terrainGrid';
import { seedInput, widthInput } from './dom';

export const camera = new Camera();
export const session = new EditorSession();
export const terrainStore = new TerrainGridStore();
export const cityStore = new CityStore();

/** City grab tolerance in on-screen px — converted to tile units at the current zoom, so the grab
 * target stays the same physical size on screen however far the camera is zoomed out. */
const HIT_RADIUS_PX = 8;

export function hitRadiusTiles(): number {
  return HIT_RADIUS_PX / camera.tp;
}

/** Brush footprint in tiles, straight off the toolbar slider. */
export function brushDiameter(): number {
  return Math.max(1, Math.round(Number(widthInput.value) || 1));
}

/** The world seed everything renders and publishes against. Lives in the toolbar input rather than
 * in a class because the text field IS the control — nothing else can change it. */
export function worldId(): string {
  return seedInput.value || 'preview';
}
