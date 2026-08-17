/**
 * skinAvatarArt.ts — the 6 "skin" avatar bust portraits (one per paid skin).
 *
 * Distinct from `cardArt.ts`'s `UNIT_ART_URLS` (full-body battle art) and from `SKIN_TARGET_UNIT`
 * (skin-id → unit-id mapping used for battle rendering, unrelated to avatars) — these are dedicated
 * head-and-shoulders bust portraits themed with each skin's own color/prop identity, drawn to the
 * same bust-portrait contract as `presetAvatarArt.ts`/`heroAvatarArt.ts` (see
 * design/product/avatar-art-prompts.md §三"备选路径 B" for the prompts). Each portrait is an
 * independent PNG, imported the same way `heroAvatarArt.ts` imports `HERO_AVATAR_ART_URLS`.
 *
 * Keys are the skin ids themselves (`SKIN_TARGET_UNIT`'s keys), NOT unit ids — `avatarPicker.ts`'s
 * `pickerItems('skin', ...)` already emits avatar ids built from these skin ids.
 *
 * Wired into avatar.ts — `categoryIcon('skin', ...)` reads this table instead of falling back to
 * `UNIT_ART_URLS` via `SKIN_TARGET_UNIT` (that fallback was the "接线时要修的 bug" §三 called out).
 */
import shopC1ArtUrl from '../assets/avatars/skin/avatar_skin_shop_c1.png';
import shopR1ArtUrl from '../assets/avatars/skin/avatar_skin_shop_r1.png';
import shopE1ArtUrl from '../assets/avatars/skin/avatar_skin_shop_e1.png';
import e1ArtUrl from '../assets/avatars/skin/avatar_skin_e1.png';
import e2ArtUrl from '../assets/avatars/skin/avatar_skin_e2.png';
import l1ArtUrl from '../assets/avatars/skin/avatar_skin_l1.png';

/** The 6 skin avatar keys — matches `SKIN_TARGET_UNIT`'s skin-id keys in skinDefs.ts. */
export const SKIN_AVATAR_KEYS = ['skin_shop_c1', 'skin_shop_r1', 'skin_shop_e1', 'skin_e1', 'skin_e2', 'skin_l1'] as const;

export type SkinAvatarKey = (typeof SKIN_AVATAR_KEYS)[number];

/** Bust-portrait URL for each skin avatar key (`buildPortraitIcon` handles the circular crop). */
export const SKIN_AVATAR_ART_URLS: Record<SkinAvatarKey, string> = {
  skin_shop_c1: shopC1ArtUrl as string,
  skin_shop_r1: shopR1ArtUrl as string,
  skin_shop_e1: shopE1ArtUrl as string,
  skin_e1: e1ArtUrl as string,
  skin_e2: e2ArtUrl as string,
  skin_l1: l1ArtUrl as string,
};
