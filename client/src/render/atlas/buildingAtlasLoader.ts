/**
 * buildingAtlasLoader.ts — SLG map overlay-building atlas loader.
 *
 * Hand-drawn structures that stand centered ON a map tile (distinct from the
 * ground-texture terrain atlas), packed into the shared worldAtlas (see that
 * module) as the `building_*`/`icon_watchtower` frames:
 *   building_keep       — strategic chokepoint gatehouse (tile type `familyKeep`)
 *   building_stronghold — dark NPC fort (tile type `stronghold`)
 *   building_bridge     — capturable river crossing bridge (tile type `bridge`)
 *   building_plankway   — capturable mountain crossing plankway (tile type `plankway`)
 *   icon_watchtower     — player-built lookout (tile.watchtower)
 *
 * Loading is fire-and-forget (called on WorldMapScene construction). A decode failure
 * does not block the map: keep/stronghold still show their terrain ground texture, and
 * the watchtower falls back to the programmatic geometric marker. Ink lines are neutral
 * and must NOT be tinted (ownership/level are conveyed by the tile wash underneath).
 */
import { worldAtlas as atlas } from './worldAtlas';

/** True once the atlas PNG has decoded and frames are parsed. */
export const isBuildingAtlasReady = atlas.isReady;

/** Texture for a building frame (`building_keep` | `building_stronghold` | `building_bridge` | `building_plankway` | `icon_watchtower`), or null. */
export const getBuildingTexture = atlas.getTexture;

/**
 * Decode + parse the shared world atlas. Idempotent; concurrent calls share one
 * in-flight promise. Failure is non-fatal — see the module header for per-frame
 * fallbacks.
 */
export const loadBuildingAtlas = atlas.load;
