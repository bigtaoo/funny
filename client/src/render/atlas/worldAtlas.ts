/**
 * worldAtlas.ts — shared SLG atlas backing terrainAtlasLoader/cityAtlasLoader/
 * playerBaseAtlasLoader/resAtlasLoader/buildingAtlasLoader/cityBldAtlasLoader.
 *
 * terrain/city/playerbase/res/building all load together in one Promise.all on
 * WorldMapScene construction (WorldMapRenderer/lifecycle.ts); city_bld_atlas is
 * CityScene's own (loads alongside res_atlas there). None of their frame names
 * collide (verified at merge time — see art/scripts/mergeAssetAtlases.js), so
 * they're packed into one PNG/JSON (`assets/slg/world_atlas.{png,json}`) and
 * decoded once. Each consumer module still looks up its own frames by explicit
 * key, so sharing one underlying sheet is transparent to them.
 */
import * as PIXI from 'pixi.js-legacy';
import { createAtlasLoader } from './spriteAtlas';
import atlasUrl from '../../assets/slg/world_atlas.png';
import atlasData from '../../assets/slg/world_atlas.json';

// Several of the merged frame sets (res/city-building icons) are drawn far
// smaller than their packed cell — mipmap + LINEAR keeps the shrink crisp
// instead of muddy (was set per-atlas on resAtlasLoader/cityBldAtlasLoader
// only; harmless for the other frame sets since they're mostly shown near
// native size).
export const worldAtlas = createAtlasLoader(atlasUrl as string, atlasData as PIXI.ISpritesheetData, 'world', {
  scaleMode: PIXI.SCALE_MODES.LINEAR,
  mipmap: PIXI.MIPMAP_MODES.ON,
});
