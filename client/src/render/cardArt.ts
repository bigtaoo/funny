/**
 * cardArt.ts — single source of truth for card / unit illustrations (png art).
 *
 * Battle hand (HandView) and the card codex (CardCodexScene) must show the
 * SAME picture for the same card, or the player gets confused. So the url maps
 * and the card→key resolver live here and are imported by both. Spell art has
 * the marker-red highlight baked in (art-direction §3.3) — never tint it.
 */
import * as PIXI from 'pixi.js-legacy';
import { CardDefinition, CardType, UnitType, BuildingType, SpellType } from '../game/types';
import { CARD_DEFS } from '../game/meta/cardDefs';
import { skinEquipKey } from '../game/meta/skinDefs';
import { preloadTextureList, ART_TEX_OPTIONS } from '../assets/preloadTextures';
import infantryArtUrl from '../assets/units/infantry.png';
import archerArtUrl from '../assets/units/archer.png';
import shieldBearerArtUrl from '../assets/units/shieldbearer.png';
import maxArtUrl from '../assets/units/max.png';
import lenaArtUrl from '../assets/units/lena.png';
import maraArtUrl from '../assets/units/mara.png';
import ironcladArtUrl from '../assets/units/ironclad.png';
import runnerArtUrl from '../assets/units/runner.png';
import harpyArtUrl from '../assets/units/harpy.png';
import medicArtUrl from '../assets/units/medic.png';
import berserkerArtUrl from '../assets/units/berserker.png';
import splitterArtUrl from '../assets/units/splitter.png';
import barracksArtUrl from '../assets/buildings/game_infantry_barracks.png';
import towerArtUrl from '../assets/buildings/game_archer_barracks.png';
import spellHasteArtUrl from '../assets/spells/spell_haste.png';
import spellMeteorArtUrl from '../assets/spells/spell_meteor.png';
import spellRockslideArtUrl from '../assets/spells/spell_rockslide.png';
import spellBridgeCollapseArtUrl from '../assets/spells/spell_bridge_collapse.png';
import skinInfantryArtUrl from '../assets/units/skins/skin_infantry.png';
import skinArcherArtUrl from '../assets/units/skins/skin_archer.png';
import skinShieldBearerArtUrl from '../assets/units/skins/skin_shieldbearer.png';

/** Card illustration by `<type>_<subtype>` key (see {@link cardArtKey}). */
export const CARD_ART_URLS: Record<string, string> = {
  [`unit_${UnitType.Infantry}`]:           infantryArtUrl as string,
  [`unit_${UnitType.Archer}`]:             archerArtUrl as string,
  [`unit_${UnitType.ShieldBearer}`]:       shieldBearerArtUrl as string,
  [`unit_${UnitType.Max}`]:               maxArtUrl as string,
  [`unit_${UnitType.Lena}`]:              lenaArtUrl as string,
  [`unit_${UnitType.Mara}`]:              maraArtUrl as string,
  [`unit_${UnitType.Ironclad}`]:           ironcladArtUrl as string,
  [`unit_${UnitType.Runner}`]:             runnerArtUrl as string,
  [`unit_${UnitType.Harpy}`]:              harpyArtUrl as string,
  [`unit_${UnitType.Medic}`]:              medicArtUrl as string,
  [`unit_${UnitType.Berserker}`]:          berserkerArtUrl as string,
  [`unit_${UnitType.Splitter}`]:           splitterArtUrl as string,
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

/**
 * Portrait override by skin id, for skins with dedicated illustration art (skinDefs.ts SKIN_TARGET_UNIT).
 * Skins with no entry here (skin_e1/skin_e2/skin_l1 — only battle rig art exists) fall back to the
 * base unit's UNIT_ART_URLS portrait via {@link unitPortraitUrl}.
 */
export const SKIN_PORTRAIT_ART: Record<string, string> = {
  skin_shop_c1: skinInfantryArtUrl as string,
  skin_shop_r1: skinArcherArtUrl as string,
  skin_shop_e1: skinShieldBearerArtUrl as string,
};

/** Portrait for a unit type given its currently equipped skin (or null/none) — the skin-aware UNIT_ART_URLS lookup. */
export function unitPortraitUrl(unitType: UnitType, equippedSkinId?: string | null): string | null {
  if (equippedSkinId) {
    const skinArt = SKIN_PORTRAIT_ART[equippedSkinId];
    if (skinArt) return skinArt;
  }
  return UNIT_ART_URLS[unitType] ?? null;
}

/** Currently-equipped skin id for a unit type, out of a `SaveData.equipped` map (or none/no map). */
export function equippedSkinIdFor(unitType: UnitType, equipped?: Record<string, string>): string | null {
  return equipped?.[skinEquipKey(unitType)] ?? null;
}

/**
 * Portrait for an owned character-card instance (CC-3): defId → CARD_DEFS.unitType → unitPortraitUrl,
 * skin-aware when a `SaveData.equipped` map is passed. Every scene that shows a card's picture
 * (formation editor, city team row, world-map team picker, roster, auction, mail, gacha reveal…)
 * goes through here so they can never drift onto different art for the same card.
 */
export function cardInstanceArtUrl(card: { defId: string } | undefined | null, equipped?: Record<string, string>): string | null {
  const def = card ? CARD_DEFS[card.defId] : undefined;
  if (!def) return null;
  const unitType = def.unitType as UnitType;
  return unitPortraitUrl(unitType, equippedSkinIdFor(unitType, equipped));
}

/** Texture cache keyed by url — shared with the `PIXI.Texture.from` global cache. */
export function getArtTexture(url: string): PIXI.Texture {
  // Match the mipmap opt-in preloadTexture() bakes in, so art created lazily here (not
  // preloaded) still minifies cleanly instead of aliasing into white speckles. Options
  // only apply on first creation; a no-op once the base texture is already cached.
  return PIXI.Texture.from(url, ART_TEX_OPTIONS);
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
