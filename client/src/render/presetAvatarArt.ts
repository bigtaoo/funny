/**
 * presetAvatarArt.ts — the 20 free "preset" avatar bust portraits.
 *
 * Replaces the old 8-icon `avatarAtlas.ts`/`icons_atlas` white-line set (misfiled objects,
 * not faces — see design/product/avatar-art-prompts.md for the full rationale). Each portrait
 * is an independent PNG (not packed into an atlas — `buildPortraitIcon`'s runtime circular crop
 * needs a clean source image, and this set is small enough that a spritesheet buys nothing),
 * imported the same way `cardArt.ts` imports `UNIT_ART_URLS`.
 *
 * Wired into avatar.ts (`resolvePresetArtUrl` → `buildPortraitIcon`) and avatarPicker.ts (the
 * preset tab's item list) since 98a8975a, which also completed the rest of avatar-art-prompts.md
 * §四: the equip/material categories are gone and stored `equip:*`/`material:*` avatarIds are
 * migrated server-side (metaserver `sanitizeEquippedAvatar`).
 */
import gogetterArtUrl from '../assets/avatars/preset/preset_gogetter.png';
import sunnyArtUrl from '../assets/avatars/preset/preset_sunny.png';
import hypeArtUrl from '../assets/avatars/preset/preset_hype.png';
import fanboyArtUrl from '../assets/avatars/preset/preset_fanboy.png';
import chuuniArtUrl from '../assets/avatars/preset/preset_chuuni.png';
import observerArtUrl from '../assets/avatars/preset/preset_observer.png';
import emoArtUrl from '../assets/avatars/preset/preset_emo.png';
import dreamerArtUrl from '../assets/avatars/preset/preset_dreamer.png';
import shyArtUrl from '../assets/avatars/preset/preset_shy.png';
import lazyArtUrl from '../assets/avatars/preset/preset_lazy.png';
import aloofArtUrl from '../assets/avatars/preset/preset_aloof.png';
import hotheadArtUrl from '../assets/avatars/preset/preset_hothead.png';
import perfectionistArtUrl from '../assets/avatars/preset/preset_perfectionist.png';
import snarkArtUrl from '../assets/avatars/preset/preset_snark.png';
import slyArtUrl from '../assets/avatars/preset/preset_sly.png';
import tsundereArtUrl from '../assets/avatars/preset/preset_tsundere.png';
import peacemakerArtUrl from '../assets/avatars/preset/preset_peacemaker.png';
import nerdcrushArtUrl from '../assets/avatars/preset/preset_nerdcrush.png';
import softieArtUrl from '../assets/avatars/preset/preset_softie.png';
import curiousArtUrl from '../assets/avatars/preset/preset_curious.png';

/** The 20 preset avatar keys, in the four personality-group order used by the design doc. */
export const PRESET_AVATAR_KEYS = [
  // A — 张扬外放型
  'gogetter', 'sunny', 'hype', 'fanboy', 'chuuni',
  // B — 内敛细腻型
  'observer', 'emo', 'dreamer', 'shy', 'lazy',
  // C — 棱角鲜明型
  'aloof', 'hothead', 'perfectionist', 'snark', 'sly',
  // D — 反差萌型
  'tsundere', 'peacemaker', 'nerdcrush', 'softie', 'curious',
] as const;

export type PresetAvatarKey = (typeof PRESET_AVATAR_KEYS)[number];

/** Bust-portrait URL for each preset avatar key (`buildPortraitIcon` handles the circular crop). */
export const PRESET_AVATAR_ART_URLS: Record<PresetAvatarKey, string> = {
  gogetter: gogetterArtUrl as string,
  sunny: sunnyArtUrl as string,
  hype: hypeArtUrl as string,
  fanboy: fanboyArtUrl as string,
  chuuni: chuuniArtUrl as string,
  observer: observerArtUrl as string,
  emo: emoArtUrl as string,
  dreamer: dreamerArtUrl as string,
  shy: shyArtUrl as string,
  lazy: lazyArtUrl as string,
  aloof: aloofArtUrl as string,
  hothead: hotheadArtUrl as string,
  perfectionist: perfectionistArtUrl as string,
  snark: snarkArtUrl as string,
  sly: slyArtUrl as string,
  tsundere: tsundereArtUrl as string,
  peacemaker: peacemakerArtUrl as string,
  nerdcrush: nerdcrushArtUrl as string,
  softie: softieArtUrl as string,
  curious: curiousArtUrl as string,
};
