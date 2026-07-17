/**
 * titleArt.ts — AI-doodle medal art for the 4 permanent titles (TITLE_DESIGN.md).
 *
 * Single dark-ink line art (unlike spell art, no baked accent colour) — TitlesScene
 * tints the sprite per owned/equipped/locked state, same role the old programmatic
 * 'medal' glyph played. Seasonal titles (ladder.s{N}.* / slg.s{N}.*) have no fixed art
 * (unbounded id space) and keep falling back to the generic glyph.
 */
import * as PIXI from 'pixi.js-legacy';
import founderArtUrl from '../assets/title_founder.png';
import conquerorArtUrl from '../assets/title_conqueror.png';
import veteranArtUrl from '../assets/title_veteran.png';
import newbieArtUrl from '../assets/title_newbie.png';

export const TITLE_ICON_URLS: Record<string, string> = {
  'event.founder':     founderArtUrl as string,
  'ach.all_chapters':  conquerorArtUrl as string,
  'ach.pvp.veteran':   veteranArtUrl as string,
  'event.newbie':      newbieArtUrl as string,
};

export function titleIconUrl(titleId: string): string | null {
  return TITLE_ICON_URLS[titleId] ?? null;
}

/** Texture cache keyed by url — shared with the `PIXI.Texture.from` global cache. */
export function getTitleIconTexture(url: string): PIXI.Texture {
  return PIXI.Texture.from(url);
}
