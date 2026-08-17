/**
 * cityBldAtlasLoader.ts — CityScene ("Home Desk") building icon atlas loader.
 *
 * Six hand-drawn stationery-themed building icons, packed into the shared
 * worldAtlas (see that module) as the `bld_*` frames: bld_desk / bld_cabinet /
 * bld_drillYard / bld_wall / bld_satchel / bld_academy (added 2026-08-17).
 * Replaces the programmatic icons.ts line-art (desk/cabinet/drillYard/wall/academy)
 * and emoji fallback (satchel) previously used by CityScene.bldIcon().
 *
 * Loading is fire-and-forget (called from CityScene.load()). A decode failure falls
 * back to the pre-existing programmatic/emoji icon — see CityScene.bldIcon().
 * Motif lines are black hand-drawn and must NOT be tinted.
 */
import { worldAtlas as atlas } from './worldAtlas';

/** True once the atlas PNG has decoded and frames are parsed. */
export const isCityBldAtlasReady = atlas.isReady;

/** Texture for a building frame (e.g. `bld_desk`), or null if not ready/unknown. */
export const getCityBldTexture = atlas.getTexture;

/**
 * Decode + parse the shared world atlas. Idempotent; concurrent calls share
 * one in-flight promise. Rejects on PNG decode error; callers fall back to the
 * pre-existing programmatic/emoji icon.
 */
export const loadCityBldAtlas = atlas.load;
