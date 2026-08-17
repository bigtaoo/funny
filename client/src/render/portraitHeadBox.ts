/**
 * portraitHeadBox.ts — where the head sits inside each bust portrait.
 *
 * The 32 bust portraits (presetAvatarArt.ts + heroAvatarArt.ts + skinAvatarArt.ts) follow one
 * composition brief, but the actual geometry varies far more than the brief implies: hair top
 * ranges 0.03-0.13 of the image height, the chin/neck 0.52-0.69, head width 0.58-0.94 of the image
 * width. A single global crop constant therefore has to leave headroom for the loosest portrait,
 * which leaves every other one looking small inside its circle — the "头像偏小" the avatar picker
 * showed even after the 2026-08-15 rim/zoom pass. `buildPortraitIcon` normalises each portrait
 * against its own head box instead, so all 32 frame identically: hair top just inside the rim,
 * crop landing at the neck.
 *
 * Measured, not hand-tuned: `art/scripts/measureAvatarHeadBox.mjs` finds the hair top (first row
 * with real ink), the neck (narrowest row between the head's widest row and the shoulders flaring
 * out) and the head's widest row. Re-run it and paste its output when a portrait is added or
 * repainted — a missing entry falls back to a plain width fit, which is safe but loose.
 */
import type { PresetAvatarKey } from './presetAvatarArt';
import type { HeroAvatarKey } from './heroAvatarArt';
import type { SkinAvatarKey } from './skinAvatarArt';

/** Head extents as fractions of the source image: hair top, neck, and the head's widest row. */
export interface HeadBox {
  top: number;
  bottom: number;
  width: number;
}

export const PRESET_HEAD_BOX: Record<PresetAvatarKey, HeadBox> = {
  gogetter: { top: 0.0911, bottom: 0.6237, width: 0.875 },
  sunny: { top: 0.1027, bottom: 0.6905, width: 0.9023 },
  hype: { top: 0.0273, bottom: 0.6602, width: 0.791 },
  fanboy: { top: 0.0846, bottom: 0.6667, width: 0.9141 },
  chuuni: { top: 0.0742, bottom: 0.6107, width: 0.7402 },
  observer: { top: 0.1302, bottom: 0.6263, width: 0.7383 },
  emo: { top: 0.0495, bottom: 0.6589, width: 0.7559 },
  dreamer: { top: 0.0921, bottom: 0.6667, width: 0.8438 },
  shy: { top: 0.0964, bottom: 0.5964, width: 0.8008 },
  lazy: { top: 0.1133, bottom: 0.6589, width: 0.7891 },
  aloof: { top: 0.0703, bottom: 0.6927, width: 0.7988 },
  hothead: { top: 0.1094, bottom: 0.6198, width: 0.7207 },
  perfectionist: { top: 0.0615, bottom: 0.6281, width: 0.666 },
  snark: { top: 0.0977, bottom: 0.6471, width: 0.8105 },
  sly: { top: 0.0964, bottom: 0.6081, width: 0.7988 },
  tsundere: { top: 0.1042, bottom: 0.651, width: 0.9414 },
  peacemaker: { top: 0.0755, bottom: 0.6198, width: 0.8574 },
  nerdcrush: { top: 0.0885, bottom: 0.5716, width: 0.7109 },
  softie: { top: 0.0859, bottom: 0.625, width: 0.7773 },
  curious: { top: 0.1146, bottom: 0.6484, width: 0.7383 },
};

export const HERO_HEAD_BOX: Record<HeroAvatarKey, HeadBox> = {
  infantry: { top: 0.0299, bottom: 0.6667, width: 0.9316 },
  archer: { top: 0.1107, bottom: 0.569, width: 0.6777 },
  shieldbearer: { top: 0.0859, bottom: 0.5938, width: 0.7441 },
  max: { top: 0.0625, bottom: 0.5208, width: 0.5859 },
  lena: { top: 0.0339, bottom: 0.5313, width: 0.5801 },
  mara: { top: 0.0625, bottom: 0.599, width: 0.752 },
};

export const SKIN_HEAD_BOX: Record<SkinAvatarKey, HeadBox> = {
  skin_shop_c1: { top: 0.0391, bottom: 0.6549, width: 0.8359 },
  skin_shop_r1: { top: 0.0729, bottom: 0.625, width: 0.7227 },
  skin_shop_e1: { top: 0.0571, bottom: 0.5139, width: 0.6484 },
  skin_e1: { top: 0.0625, bottom: 0.6133, width: 0.7051 },
  skin_e2: { top: 0.0547, bottom: 0.5898, width: 0.7832 },
  skin_l1: { top: 0.0365, bottom: 0.5781, width: 0.6875 },
};
