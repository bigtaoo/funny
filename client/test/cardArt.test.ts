// Regression coverage for the Hero Roster "Skins" tab bug (2026-08-01): equipping a skin didn't
// change the character card's portrait because UNIT_ART_URLS was keyed only by unitType, ignoring
// the equipped skin entirely. unitPortraitUrl() is the fix — the single skin-aware resolver every
// portrait call site (skins.ts, detail.ts, list.ts, feed.ts, CityScene, EquipmentScene,
// DefenseEditorScene, AuctionScene, GachaScene, FriendsScene mail) must go through, either directly
// or via cardInstanceArtUrl()/equippedSkinIdFor() for callers that only have a card instance/defId
// or a raw SaveData.equipped map rather than a resolved unitType + skin id pair.
import { describe, it, expect } from 'vitest';
import { UNIT_ART_URLS, SKIN_PORTRAIT_ART, unitPortraitUrl, equippedSkinIdFor, cardInstanceArtUrl } from '../src/render/cardArt';
import { skinEquipKey } from '../src/game/meta/skinDefs';
import { UnitType } from '../src/game/types';

describe('unitPortraitUrl', () => {
  it('falls back to the base unit portrait when no skin is equipped', () => {
    expect(unitPortraitUrl(UnitType.Infantry, null)).toBe(UNIT_ART_URLS.infantry);
    expect(unitPortraitUrl(UnitType.Infantry, undefined)).toBe(UNIT_ART_URLS.infantry);
  });

  it('returns the skin portrait when the equipped skin has dedicated art', () => {
    expect(unitPortraitUrl(UnitType.Infantry, 'skin_shop_c1')).toBe(SKIN_PORTRAIT_ART.skin_shop_c1);
    expect(unitPortraitUrl(UnitType.Infantry, 'skin_shop_c1')).not.toBe(UNIT_ART_URLS.infantry);
    expect(unitPortraitUrl(UnitType.Archer, 'skin_shop_r1')).toBe(SKIN_PORTRAIT_ART.skin_shop_r1);
    expect(unitPortraitUrl(UnitType.ShieldBearer, 'skin_shop_e1')).toBe(SKIN_PORTRAIT_ART.skin_shop_e1);
  });

  it('falls back to the base unit portrait for skins with no dedicated portrait art (rig-only)', () => {
    // skin_e1/skin_e2/skin_l1 (Lena/Mara/Max) only have battle-rig (.tao) art today, no static portrait.
    expect(unitPortraitUrl(UnitType.Lena, 'skin_e1')).toBe(UNIT_ART_URLS.lena);
    expect(unitPortraitUrl(UnitType.Max, 'skin_l1')).toBe(UNIT_ART_URLS.max);
  });
});

describe('equippedSkinIdFor', () => {
  it('returns null when no equipped map is passed, or the character has no slot in it', () => {
    expect(equippedSkinIdFor(UnitType.Infantry, undefined)).toBeNull();
    expect(equippedSkinIdFor(UnitType.Infantry, {})).toBeNull();
    expect(equippedSkinIdFor(UnitType.Infantry, { [skinEquipKey(UnitType.Archer)]: 'skin_shop_r1' })).toBeNull();
  });

  it('reads the right character\'s slot out of a SaveData.equipped-shaped map', () => {
    const equipped = { [skinEquipKey(UnitType.Infantry)]: 'skin_shop_c1', title: 'champion' };
    expect(equippedSkinIdFor(UnitType.Infantry, equipped)).toBe('skin_shop_c1');
  });
});

describe('cardInstanceArtUrl', () => {
  it('resolves through def.unitType and follows the equipped skin, same as unitPortraitUrl', () => {
    const equipped = { [skinEquipKey(UnitType.Infantry)]: 'skin_shop_c1' };
    expect(cardInstanceArtUrl({ defId: 'lichuang' }, equipped)).toBe(SKIN_PORTRAIT_ART.skin_shop_c1);
    expect(cardInstanceArtUrl({ defId: 'lichuang' }, {})).toBe(UNIT_ART_URLS.infantry);
  });

  it('ignores an unrelated character\'s equipped skin', () => {
    // Li Chuang (infantry) must not pick up Chen Shou's (shieldbearer) equipped skin.
    const equipped = { [skinEquipKey(UnitType.ShieldBearer)]: 'skin_shop_e1' };
    expect(cardInstanceArtUrl({ defId: 'lichuang' }, equipped)).toBe(UNIT_ART_URLS.infantry);
  });

  it('returns null for an unknown defId or a null/undefined card', () => {
    expect(cardInstanceArtUrl({ defId: 'not_a_real_card' })).toBeNull();
    expect(cardInstanceArtUrl(null)).toBeNull();
    expect(cardInstanceArtUrl(undefined)).toBeNull();
  });

  it('works with no equipped map at all (every call site with an absent/optional callback)', () => {
    expect(cardInstanceArtUrl({ defId: 'lichuang' })).toBe(UNIT_ART_URLS.infantry);
  });
});
