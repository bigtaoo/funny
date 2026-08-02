/**
 * iconsAtlas.ts — shared L0 icon atlas backing equipmentAtlas/materialAtlas/
 * factionIcon/avatarAtlas.
 *
 * These 4 small icon sets (12 + 3 + 2 + 8 frames) all load together at app boot
 * (bootManifest.ts) and never collide on frame name (verified at merge time —
 * see art/scripts/mergeAssetAtlases.js), so they're packed into one PNG/JSON
 * (`assets/icons/icons_atlas.{png,json}`) and decoded once instead of 4 separate
 * HTTP fetches + Spritesheet parses. Each consumer module still looks up its own
 * frames by explicit key (defId / material kind / faction / avatar key), so
 * sharing one underlying sheet is transparent to them.
 */
import * as PIXI from 'pixi.js-legacy';
import { createAtlasLoader } from './spriteAtlas';
import atlasUrl from '../../assets/icons/icons_atlas.png';
import atlasData from '../../assets/icons/icons_atlas.json';

export const iconsAtlas = createAtlasLoader(atlasUrl as string, atlasData as PIXI.ISpritesheetData, 'icons');
