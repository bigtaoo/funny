/**
 * heroAvatarArt.ts — the 6 "hero" avatar bust portraits (one per playable unit/hero).
 *
 * Distinct from `cardArt.ts`'s `UNIT_ART_URLS`, which are full-body battle/card illustrations —
 * these are dedicated "everyday clothes" bust portraits with no weapon/battle pose, drawn to the
 * same bust-portrait contract as `presetAvatarArt.ts` (see design/product/avatar-art-prompts.md
 * §一 for the prompts and per-character identity notes: 李川/苏远/陈守 use the 涛方 cartoon face,
 * Max/Lena/Mara use the Anna realistic face). Each portrait is an independent PNG, imported the
 * same way `cardArt.ts` imports `UNIT_ART_URLS`.
 *
 * Wired into avatar.ts — `categoryIcon('hero', ...)` reads this table (the `'bust'` framing branch
 * of `buildPortraitIcon`), not `UNIT_ART_URLS`. Only the `skin` category still falls back to the
 * battle art, per avatar-art-prompts.md §三.
 */
import infantryArtUrl from '../assets/avatars/hero/hero_infantry.png';
import archerArtUrl from '../assets/avatars/hero/hero_archer.png';
import shieldbearerArtUrl from '../assets/avatars/hero/hero_shieldbearer.png';
import maxArtUrl from '../assets/avatars/hero/hero_max.png';
import lenaArtUrl from '../assets/avatars/hero/hero_lena.png';
import maraArtUrl from '../assets/avatars/hero/hero_mara.png';

/** The 6 hero avatar keys — matches `UNIT_ART_URLS`' unit-id keys in cardArt.ts. */
export const HERO_AVATAR_KEYS = ['infantry', 'archer', 'shieldbearer', 'max', 'lena', 'mara'] as const;

export type HeroAvatarKey = (typeof HERO_AVATAR_KEYS)[number];

/** Bust-portrait URL for each hero avatar key (`buildPortraitIcon` handles the circular crop). */
export const HERO_AVATAR_ART_URLS: Record<HeroAvatarKey, string> = {
  infantry: infantryArtUrl as string,
  archer: archerArtUrl as string,
  shieldbearer: shieldbearerArtUrl as string,
  max: maxArtUrl as string,
  lena: lenaArtUrl as string,
  mara: maraArtUrl as string,
};
