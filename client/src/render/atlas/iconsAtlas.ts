/**
 * iconsAtlas.ts — shared L0 icon atlas backing equipmentAtlas/materialAtlas/factionIcon.
 *
 * These 3 small icon sets (12 + 3 + 2 frames) all load together at app boot
 * (bootManifest.ts) and never collide on frame name (verified at merge time —
 * see art/scripts/mergeAssetAtlases.js), so they're packed into one PNG/JSON
 * (`assets/icons/icons_atlas.{png,json}`) and decoded once instead of 3 separate
 * HTTP fetches + Spritesheet parses. Each consumer module still looks up its own
 * frames by explicit key (defId / material kind / faction), so sharing one
 * underlying sheet is transparent to them.
 *
 * There was a FOURTH set here — the 8 white-line `avatarAtlas.ts` frames (book/trophy/
 * swords/castle/pencils/globe/coin/home). presetAvatarArt.ts replaced them with 20
 * standalone bust PNGs and avatarAtlas.ts was deleted, but the frames stayed in the page
 * for weeks: nothing enumerates this atlas (`frameNames()` has one caller, and it is the
 * decor page), so 8 unreachable frames cost boot bytes and texture memory in silence.
 * Evicted 2026-08-27 in the repack that also un-quantised the page — see
 * design/game/ASSET_PACKAGING.md §16.
 */
import * as PIXI from 'pixi.js-legacy';
import { createAtlasLoader } from './spriteAtlas';
import atlasUrl from '../../assets/icons/icons_atlas.png';
import atlasData from '../../assets/icons/icons_atlas.json';

export const iconsAtlas = createAtlasLoader(atlasUrl as string, atlasData as PIXI.ISpritesheetData, 'icons');
