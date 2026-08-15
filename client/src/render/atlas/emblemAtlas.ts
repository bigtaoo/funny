/**
 * emblemAtlas.ts — family/sect emblem icon atlas (design/product/family-emblem-art-prompts.md).
 *
 * 24-design fixed pool (AI line-art, art/icons/pack_emblem_atlas.js), packed as
 * WHITE lines on transparent — same single-colour-source contract as the faction
 * totems (art/ui/camps/pack_faction_atlas.js) — so the client can `tint` each
 * emblem to whatever accent colour a family/sect picks at runtime.
 *
 * Not wired into bootManifest L0: nothing consumes this atlas yet (the
 * family/sect creation flow has no `emblemKey` field or picker UI — see the
 * TODO list at the bottom of family-emblem-art-prompts.md). Load it lazily
 * (`loadEmblemAtlas`, see emblemIcon.ts) once that UI lands, mirroring how
 * every other L1 atlas (city/building/playerBase/...) is fetched on scene
 * entry rather than at boot.
 */
import * as PIXI from 'pixi.js-legacy';
import { createAtlasLoader } from './spriteAtlas';
import atlasUrl from '../../assets/emblems/emblems.png';
import atlasData from '../../assets/emblems/emblems.json';

export const emblemAtlas = createAtlasLoader(atlasUrl as string, atlasData as PIXI.ISpritesheetData, 'emblems');
