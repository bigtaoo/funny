/**
 * gachaArt.ts — gacha 界面图片资产（卡背、边框、banner）。
 *
 * 卡背（400×560）和边框（480×480）按稀有度各一张；
 * banner 按池类型：含 "limited" 的 id 用限定图，其余用常驻图。
 */
import * as PIXI from 'pixi.js-legacy';
import type { Rarity } from '../game/meta/SaveData';

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
