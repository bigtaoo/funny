/**
 * gachaArt.ts — gacha screen image assets (card backs, frames, banners).
 *
 * One card back (400×560) and one frame (480×480) per rarity tier;
 * banner by pool type: ids containing "limited" use the limited banner, others use the standard banner.
 */
import * as PIXI from 'pixi.js-legacy';
import type { Rarity } from '../game/meta/SaveData';
import { preloadTextureList } from '../assets/preloadTextures';

import cardCommonUrl    from '../assets/gacha/gacha_card_common.png';
import cardRareUrl      from '../assets/gacha/gacha_card_rare.png';
import cardEpicUrl      from '../assets/gacha/gacha_card_epic.png';
import cardLegendaryUrl from '../assets/gacha/gacha_card_legendary.png';

import frameCommonUrl    from '../assets/gacha/frame_common.png';
import frameRareUrl      from '../assets/gacha/frame_rare.png';
import frameEpicUrl      from '../assets/gacha/frame_epic.png';
import frameLegendaryUrl from '../assets/gacha/frame_legendary.png';

import bannerLimitedUrl  from '../assets/gacha/banner_limited_01.png';
import bannerStandardUrl from '../assets/gacha/banner_standard.png';

const CARD_URLS: Record<Rarity, string> = {
  common:    cardCommonUrl    as string,
  rare:      cardRareUrl      as string,
  epic:      cardEpicUrl      as string,
  legendary: cardLegendaryUrl as string,
};

const FRAME_URLS: Record<Rarity, string> = {
  common:    frameCommonUrl    as string,
  rare:      frameRareUrl      as string,
  epic:      frameEpicUrl      as string,
  legendary: frameLegendaryUrl as string,
};

export function gachaCardTexture(rarity: Rarity): PIXI.Texture {
  return PIXI.Texture.from(CARD_URLS[rarity]);
}

export function gachaFrameTexture(rarity: Rarity): PIXI.Texture {
  return PIXI.Texture.from(FRAME_URLS[rarity]);
}

export function gachaBannerTexture(poolId: string): PIXI.Texture {
  const url = poolId.includes('limited') ? bannerLimitedUrl as string : bannerStandardUrl as string;
  return PIXI.Texture.from(url);
}

const ALL_GACHA_URLS = [
  ...Object.values(CARD_URLS),
  ...Object.values(FRAME_URLS),
  bannerLimitedUrl  as string,
  bannerStandardUrl as string,
];

/** Warm the gacha PNG set into the AssetIO disk cache + PIXI texture cache. */
export function preloadGachaTextures(): Promise<void> {
  return preloadTextureList(ALL_GACHA_URLS);
}
