// Map-editor palettes and viewport constants (DESIGN.md §6.3). Pure declarations — no DOM, no PIXI,
// no editor state — so both index.ts and the render/ modules can read them without an import cycle.
import type { TerrainKind } from './state/terrainGrid';
import type { MapEditorCityNode } from './state/cities';
import type { TileType } from '@nw/shared/slg';

export const TERRAIN_COLORS: Record<TerrainKind, number> = {
  river: 0x4fa8e0, mountain: 0xa0785a,
  neutral: 0x9ccf7a, // carve: open a band back to passable land
  bridge: 0x5c9fd6, // river crossing (bridge)
  plankway: 0xc08a52, // mountain crossing (plankway)
};
export const CITY_COLORS: Record<MapEditorCityNode['kind'], number> = {
  worldCenter: 0xff5c8a,
  capital: 0xffd166,
  garrison: 0x4ce0c0,
};
export const CITY_COLORS_CSS: Record<MapEditorCityNode['kind'], string> = {
  worldCenter: '#ff5c8a',
  capital: '#ffd166',
  garrison: '#4ce0c0',
};
export const TERRAIN_LEGEND: TileType[] = ['neutral', 'resource', 'territory', 'familyKeep', 'center', 'obstacle', 'bridge', 'plankway', 'stronghold'];
export const TERRAIN_LEGEND_CSS: Record<TileType, string> = {
  neutral: '#f5f0e8', resource: '#f0ece0', territory: '#f5f0e8', familyKeep: '#e8d29a',
  center: '#f0dfa0', base: '#f5f0e8', obstacle: '#c4bdb0', bridge: '#b9c6d2', plankway: '#b2967a', stronghold: '#9a7a6a',
};

// ── Viewport (camera into the up-to-500×500 world; see DESIGN.md §6.3) ────────────
export const VIEW_W = 900;
export const VIEW_H = 620;
/** Rendered tiles extend this far past the visible edge so short pans don't reveal blank space (§ live-drag tradeoff below). */
export const VIEW_PAD_FACTOR = 1.5;
export const ZOOM_MIN = 10;
export const ZOOM_MAX = 130; // raised 84→130: DEFAULT_TP (900/11≈81) sits near the old cap, so leave real zoom-in headroom
/** Default on-screen tile px = the game client's L1 (detail) density: it sizes tiles as
 * floor(viewportWidth / 11) (client/src/scenes/worldmap/zoom.ts). Matching that divisor here
 * makes the editor open with the SAME on-screen tile count the player sees at full zoom-in.
 * (Divisor 16→13→11: the map read as an over-dense carpet at higher divisors.) */
export const DEFAULT_TP = Math.floor(VIEW_W / 11);
/** On-screen width of a base's city sprite in tile-widths — mirrors the game client's BASE_SPRITE_TILES
 * (client/src/scenes/worldmap/constants.ts) so a 3×3 base's art lines up identically; larger cities scale
 * proportionally by footprint (see refreshCitySprites). */
export const BASE_SPRITE_TILES = 3.2;
