/**
 * cardArt.ts — single source of truth for card / unit illustrations (png art).
 *
 * Battle hand (HandView) and the cultivation hub (CollectionScene) must show the
 * SAME picture for the same card, or the player gets confused. So the url maps
 * and the card→key resolver live here and are imported by both. Spell art has
 * the marker-red highlight baked in (art-direction §3.3) — never tint it.
 */
import * as PIXI from 'pixi.js-legacy';
import { CardDefinition, CardType, UnitType, BuildingType, SpellType } from '../game/types';
import { preloadTextureList } from '../assets/preloadTextures';
import infantryArtUrl from '../assets/infantry.png';
import archerArtUrl from '../assets/archer.png';
import shieldBearerArtUrl from '../assets/shieldbearer.png';
import maxArtUrl from '../assets/max.png';
import lenaArtUrl from '../assets/lena.png';
import maraArtUrl from '../assets/mara.png';
import barracksArtUrl from '../assets/game_infantry_barracks.png';
import towerArtUrl from '../assets/game_archer_barracks.png';
import spellHasteArtUrl from '../assets/spell_haste.png';
import spellMeteorArtUrl from '../assets/spell_meteor.png';
import spellRockslideArtUrl from '../assets/spell_rockslide.png';
import spellBridgeCollapseArtUrl from '../assets/spell_bridge_collapse.png';

/** Card illustration by `<type>_<subtype>` key (see {@link cardArtKey}). */
export const CARD_ART_URLS: Record<string, string> = {
  [`unit_${UnitType.Infantry}`]:           infantryArtUrl as string,
  [`unit_${UnitType.Archer}`]:             archerArtUrl as string,
  [`unit_${UnitType.ShieldBearer}`]:       shieldBearerArtUrl as string,
  [`unit_${UnitType.Max}`]:               maxArtUrl as string,
  [`unit_${UnitType.Lena}`]:              lenaArtUrl as string,
  [`unit_${UnitType.Mara}`]:              maraArtUrl as string,
  [`building_${BuildingType.Barracks}`]:   barracksArtUrl as string,
  [`building_${BuildingType.ArrowTower}`]: towerArtUrl as string,
  [`spell_${SpellType.Haste}`]:            spellHasteArtUrl as string,
  [`spell_${SpellType.Meteor}`]:           spellMeteorArtUrl as string,
  [`spell_${SpellType.Rockslide}`]:        spellRockslideArtUrl as string,
  [`spell_${SpellType.BridgeCollapse}`]:   spellBridgeCollapseArtUrl as string,
};

export function cardArtKey(card: CardDefinition): string | null {
  if (card.cardType === CardType.Unit && card.unitType !== undefined) {
    return `unit_${card.unitType}`;
  }
  if (card.cardType === CardType.Building && card.buildingType !== undefined) {
    return `building_${card.buildingType}`;
  }
  if (card.cardType === CardType.Spell && card.spellType !== undefined) {
    return `spell_${card.spellType}`;
  }
  return null;
}

/** Illustration for a card, or null if it has none. */
export function cardArtUrl(card: CardDefinition): string | null {
  const key = cardArtKey(card);
  return key ? CARD_ART_URLS[key] ?? null : null;
}

/**
 * Portrait for a progressable unit id (cultivation unit tab). Anna's heroes
 * (max/lena/mara) have their own art; the PvP trio shares the hand-card art.
 */
export const UNIT_ART_URLS: Record<string, string> = {
  infantry:     infantryArtUrl as string,
  archer:       archerArtUrl as string,
  shieldbearer: shieldBearerArtUrl as string,
  max:          maxArtUrl as string,
  lena:         lenaArtUrl as string,
  mara:         maraArtUrl as string,
};

/** Texture cache keyed by url — shared with the `PIXI.Texture.from` global cache. */
export function getArtTexture(url: string): PIXI.Texture {
  return PIXI.Texture.from(url);
}

// L1 card art: heroes + spells (L0 trio infantry/archer/shieldbearer is already
// preloaded by bootManifest and excluded here).
const L1_CARD_ART_URLS = [
  maxArtUrl            as string,
  lenaArtUrl           as string,
  maraArtUrl           as string,
  spellHasteArtUrl         as string,
  spellMeteorArtUrl        as string,
  spellRockslideArtUrl     as string,
  spellBridgeCollapseArtUrl as string,
];

/** Warm L1 hero + spell card art into the AssetIO disk cache + PIXI texture cache. */
export function preloadL1CardArtTextures(): Promise<void> {
  return preloadTextureList(L1_CARD_ART_URLS);
}
