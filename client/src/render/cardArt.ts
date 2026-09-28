/**
 * cardArt.ts — single source of truth for card / unit illustrations (png art).
 *
 * Battle hand (HandView) and the card codex (CardCodexScene) must show the
 * SAME picture for the same card, or the player gets confused. So the url maps
 * and the card→key resolver live here and are imported by both. Spell art has
 * the marker-red highlight baked in (art-direction §3.3) — never tint it.
 */
import * as PIXI from 'pixi.js-legacy';
import { CardDefinition, CardType, UnitType, BuildingType, SpellType } from '@nw/engine/types';
import { CARD_DEFS } from '../game/meta/cardDefs';
import { skinEquipKey } from '../game/meta/skinDefs';
import { preloadTextureList, ART_TEX_OPTIONS } from '../assets/preloadTextures';
import { devicePxPerDesignUnit } from './bake';
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
import maxThumbUrl from '../assets/units/thumb/max.png';
import lenaThumbUrl from '../assets/units/thumb/lena.png';
import maraThumbUrl from '../assets/units/thumb/mara.png';
import ironcladThumbUrl from '../assets/units/thumb/ironclad.png';
import runnerThumbUrl from '../assets/units/thumb/runner.png';
import harpyThumbUrl from '../assets/units/thumb/harpy.png';
import medicThumbUrl from '../assets/units/thumb/medic.png';
import berserkerThumbUrl from '../assets/units/thumb/berserker.png';
import splitterThumbUrl from '../assets/units/thumb/splitter.png';
import barracksArtUrl from '../assets/buildings/game_infantry_barracks.png';
import towerArtUrl from '../assets/buildings/game_arrow_tower.png';
import spellHasteArtUrl from '../assets/spells/spell_haste.png';
import spellMeteorArtUrl from '../assets/spells/spell_meteor.png';
import spellRockslideArtUrl from '../assets/spells/spell_rockslide.png';
import spellBridgeCollapseArtUrl from '../assets/spells/spell_bridge_collapse.png';
import skinInfantryArtUrl from '../assets/units/skins/skin_infantry.png';
import skinArcherArtUrl from '../assets/units/skins/skin_archer.png';
import skinShieldBearerArtUrl from '../assets/units/skins/skin_shieldbearer.png';
import skinLenaArtUrl from '../assets/units/skins/skin_lena.png';
import skinMaraArtUrl from '../assets/units/skins/skin_mara.png';
import skinMaxArtUrl from '../assets/units/skins/skin_max.png';

/** Card illustration by `<type>_<subtype>` key (see {@link cardArtKey}). */
export const CARD_ART_URLS: Record<string, string> = {
  [`unit_${UnitType.Infantry}`]:           infantryArtUrl as string,
  [`unit_${UnitType.Archer}`]:             archerArtUrl as string,
  [`unit_${UnitType.ShieldBearer}`]:       shieldBearerArtUrl as string,
  [`unit_${UnitType.Max}`]:               maxThumbUrl as string,
  [`unit_${UnitType.Lena}`]:              lenaThumbUrl as string,
  [`unit_${UnitType.Mara}`]:              maraThumbUrl as string,
  [`unit_${UnitType.Ironclad}`]:           ironcladThumbUrl as string,
  [`unit_${UnitType.Runner}`]:             runnerThumbUrl as string,
  [`unit_${UnitType.Harpy}`]:              harpyThumbUrl as string,
  [`unit_${UnitType.Medic}`]:              medicThumbUrl as string,
  [`unit_${UnitType.Berserker}`]:          berserkerThumbUrl as string,
  [`unit_${UnitType.Splitter}`]:           splitterThumbUrl as string,
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
  max:          maxThumbUrl as string,
  lena:         lenaThumbUrl as string,
  mara:         maraThumbUrl as string,
};

/**
 * Long edge of the `assets/units/thumb/` exports; must match `THUMB_MAX_LONG_EDGE` in
 * art/scripts/exportUnitCardArt.mjs. 320 logical px (the largest box any site but the gacha reveal
 * draws unit art into) at the renderer's 2 device px per logical px ceiling.
 */
export const THUMB_LONG_EDGE = 640;

/**
 * The full-size export behind each thumbnail (ADR-096). Every map above hands out the thumbnail:
 * the full exports run up to 2181x1514, and uploading them for 100px codex tiles cost 113ms of
 * `texImage2D` in one frame — then again on every return a minute later, because textures that big
 * are what PIXI's texture GC evicts first. archer/infantry/shieldbearer have no entry: their export
 * is already thumbnail-sized, so they are their own full size.
 */
const FULL_ART_BY_THUMB: Record<string, string> = {
  [maxThumbUrl as string]:       maxArtUrl as string,
  [lenaThumbUrl as string]:      lenaArtUrl as string,
  [maraThumbUrl as string]:      maraArtUrl as string,
  [ironcladThumbUrl as string]:  ironcladArtUrl as string,
  [runnerThumbUrl as string]:    runnerArtUrl as string,
  [harpyThumbUrl as string]:     harpyArtUrl as string,
  [medicThumbUrl as string]:     medicArtUrl as string,
  [berserkerThumbUrl as string]: berserkerArtUrl as string,
  [splitterThumbUrl as string]:  splitterArtUrl as string,
};

/**
 * `url`, or the full-size export behind it when a box whose long edge is `boxLongEdge` design px
 * would magnify the thumbnail on this screen. Only the gacha reveal's single card gets that big
 * (~780 design px on a landscape window); a url that is not a thumbnail comes back unchanged.
 */
export function artUrlForBox(url: string, boxLongEdge: number): string {
  const full = FULL_ART_BY_THUMB[url];
  return full && boxLongEdge * devicePxPerDesignUnit() > THUMB_LONG_EDGE ? full : url;
}

/**
 * Portrait override by skin id, for skins with dedicated illustration art (skinDefs.ts SKIN_TARGET_UNIT).
 * Skins with no entry here fall back to the base unit's UNIT_ART_URLS portrait via {@link unitPortraitUrl}.
 */
export const SKIN_PORTRAIT_ART: Record<string, string> = {
  skin_shop_c1: skinInfantryArtUrl as string,
  skin_shop_r1: skinArcherArtUrl as string,
  skin_shop_e1: skinShieldBearerArtUrl as string,
  skin_e1: skinLenaArtUrl as string,
  skin_e2: skinMaraArtUrl as string,
  skin_l1: skinMaxArtUrl as string,
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

/**
 * Uniform "contain" scale factor to fit a `texW × texH` texture inside a `boxW × boxH`
 * box without stretching — the tighter axis wins, the other axis letterboxes. Shared by
 * every scene that centers art in a (possibly non-square) card/portrait slot
 * (ShopScene.drawCard, CardScene.drawArtFit) so they can never drift onto a per-axis
 * width/height assignment that silently distorts non-square art.
 */
export function containScale(texW: number, texH: number, boxW: number, boxH: number): number {
  return Math.min(boxW / texW, boxH / texH);
}

/**
 * A `url` sprite contain-fit and centred in a `boxW × boxH` box at local (0,0), which **lays itself
 * out the moment the PNG decodes** instead of needing the caller to re-render.
 *
 * `PIXI.Texture.from` is lazy: the first call for a url starts the fetch and hands back a texture
 * whose baseTexture is still `valid === false` (frame 1×1). A caller that just skips drawing on
 * that first frame is left with a permanently blank box unless something happens to re-render it
 * later — which is exactly the world-map shop panel's bug (2026-08-30): its cards are built once
 * when the modal opens, so every icon whose PNG had not already been warmed by an earlier scene
 * stayed empty for the life of the panel. Rather than teach each of the ~30 call sites to hook the
 * decode, the sprite fixes itself: it starts `visible = false` (so a 1×1 frame can't smear across
 * the box) and fits + shows on the baseTexture's `loaded` event. Invisible children are skipped by
 * `Container.calculateBounds`, so a not-yet-decoded icon still measures as an empty box exactly
 * like the old "return nothing" behaviour — no layout depends on the decode timing.
 *
 * The `destroyed` guard + `off` on teardown are load-bearing, not defensive noise: the texture can
 * land after the scene that asked for it is gone, and touching a destroyed Sprite throws from
 * inside a PIXI Runner on the shared ticker, which kills `Ticker.shared` and freezes the canvas
 * until a page reload (same contract IntroScene's `fitIllustration` documents — see
 * 菜单场景生命周期契约 in claudedocs/client-modules.md).
 */
export function buildFittedSprite(url: string, boxW: number, boxH: number, tint?: number): PIXI.Sprite {
  const tex = getArtTexture(url);
  const sprite = new PIXI.Sprite(tex);
  if (tint !== undefined) sprite.tint = tint;
  const fit = (): void => {
    if (sprite.destroyed) return;
    const scale = containScale(tex.width, tex.height, boxW, boxH);
    sprite.scale.set(scale);
    sprite.x = (boxW - tex.width * scale) / 2;
    sprite.y = (boxH - tex.height * scale) / 2;
    sprite.visible = true;
  };
  if (tex.baseTexture.valid) {
    fit();
    return sprite;
  }
  sprite.visible = false;
  const base = tex.baseTexture;
  base.once('loaded', fit);
  // PIXI emits 'destroyed' before dropping the object's own listeners, so this always runs — it is
  // what keeps a torn-down scene's sprite from being held alive by the (globally cached) baseTexture.
  sprite.once('destroyed', () => base.off('loaded', fit));
  return sprite;
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
  maxThumbUrl          as string,
  lenaThumbUrl         as string,
  maraThumbUrl         as string,
  spellHasteArtUrl         as string,
  spellMeteorArtUrl        as string,
  spellRockslideArtUrl     as string,
  spellBridgeCollapseArtUrl as string,
];

/** Warm L1 hero + spell card art into the AssetIO disk cache + PIXI texture cache. */
export function preloadL1CardArtTextures(): Promise<void> {
  return preloadTextureList(L1_CARD_ART_URLS);
}
