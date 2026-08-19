/**
 * buildingAtlasLoader.ts — SLG map overlay-building atlas loader.
 *
 * Hand-drawn structures that stand centered ON a map tile (distinct from the
 * ground-texture terrain atlas), packed into the shared worldAtlas (see that
 * module) as the `building_*`/`icon_*` frames:
 *   building_keep       — strategic chokepoint gatehouse. UNUSED since 2026-08-19: it was the per-tile
 *                          stamp for tile type `familyKeep`, which now only ever means city ground —
 *                          drawn by the footprint-sized city sprite instead (see
 *                          scenes/worldmap/tileGraphics/tiles.ts). Frame kept in the atlas for a future
 *                          chokepoint mechanic; nothing reads it today.
 *   building_stronghold — dark NPC fort (tile type `stronghold`)
 *   building_bridge     — capturable river crossing bridge (tile type `bridge`)
 *   building_plankway   — capturable mountain crossing plankway (tile type `plankway`)
 *   icon_watchtower     — player-built lookout (tile.watchtower); re-shot 2026-08-09 from a
 *                          front-elevation drawing to a wide 3/4-iso one, see
 *                          design/product/slg-building-art.md
 *   icon_blocker        — player-built barricade (tile.structure, kind !== 'arrowTower');
 *                          added 2026-08-09, see design/product/slg-building-art.md
 *   icon_arrowTower     — player-built arrow tower (tile.structure, kind === 'arrowTower');
 *                          added 2026-08-17 — first real art for this structure, previously
 *                          always the geometric fallback, see design/product/slg-building-art.md
 *
 * Loading is fire-and-forget (called on WorldMapScene construction). A decode failure
 * does not block the map: stronghold/crossings still show their terrain ground texture, and
 * watchtower/blocker/arrowTower fall back to their programmatic geometric markers. Ink lines
 * are neutral and must NOT be tinted (ownership/level are conveyed by the tile wash underneath).
 */
import { worldAtlas as atlas } from './worldAtlas';

/** True once the atlas PNG has decoded and frames are parsed. */
export const isBuildingAtlasReady = atlas.isReady;

/** Texture for a building frame (`building_keep` | `building_stronghold` | `building_bridge` | `building_plankway` | `icon_watchtower` | `icon_blocker`), or null. */
export const getBuildingTexture = atlas.getTexture;

/**
 * Decode + parse the shared world atlas. Idempotent; concurrent calls share one
 * in-flight promise. Failure is non-fatal — see the module header for per-frame
 * fallbacks.
 */
export const loadBuildingAtlas = atlas.load;
