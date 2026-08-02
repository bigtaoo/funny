// Regression coverage for the Hero Roster "Skins" tab bug (2026-08-01): equipping a skin didn't
// change the character card's portrait because UNIT_ART_URLS was keyed only by unitType, ignoring
// the equipped skin entirely. unitPortraitUrl() is the fix — the single skin-aware resolver every
// portrait call site (skins.ts, detail.ts, list.ts, feed.ts, CityScene, EquipmentScene,
// DefenseEditorScene, AuctionScene, GachaScene, FriendsScene mail) must go through, either directly
// or via cardInstanceArtUrl()/equippedSkinIdFor() for callers that only have a card instance/defId
// or a raw SaveData.equipped map rather than a resolved unitType + skin id pair.
import { describe, it, expect } from 'vitest';
import { UNIT_ART_URLS, SKIN_PORTRAIT_ART, unitPortraitUrl, equippedSkinIdFor, cardInstanceArtUrl, containScale } from '../src/render/cardArt';
import { skinEquipKey } from '../src/game/meta/skinDefs';
import { UnitType } from '@nw/engine/types';

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

  it('falls back to the base unit portrait for a skin id with no dedicated portrait art', () => {
    // All current shop/gacha skins (skin_shop_c1/r1/e1, skin_e1/e2/l1) now have dedicated
    // portraits registered in SKIN_PORTRAIT_ART — use a made-up id to exercise the miss path.
    expect(unitPortraitUrl(UnitType.Lena, 'skin_does_not_exist')).toBe(UNIT_ART_URLS.lena);
    expect(unitPortraitUrl(UnitType.Max, 'skin_does_not_exist')).toBe(UNIT_ART_URLS.max);
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

// Regression coverage for the Shop skin-card stretch bug (2026-08-02): drawCard() assigned
// `art.width = art.height = imgSize` independently, ignoring the source texture's aspect ratio —
// every skin portrait (all tall, non-square illustrations) was squashed/stretched into a square.
// containScale() is the fix, now shared by ShopScene.drawCard and CardScene.drawArtFit so neither
// can regress back to a per-axis width/height assignment.
describe('containScale', () => {
  it('shrinks a tall portrait to fit a square box by its height, never stretching to fill the width', () => {
    // skin_archer.png is 520×1306 (~1:2.5) — the most extreme real skin asset.
    const scale = containScale(520, 1306, 300, 300);
    expect(scale).toBeCloseTo(300 / 1306);
    const displayW = 520 * scale;
    const displayH = 1306 * scale;
    expect(displayH).toBeCloseTo(300); // touches the box on the constraining axis
    expect(displayW).toBeLessThan(300); // letterboxed, not stretched to fill the box
  });

  it('shrinks a wide texture to fit a square box by its width', () => {
    const scale = containScale(400, 100, 200, 200);
    expect(scale).toBeCloseTo(200 / 400);
    expect(400 * scale).toBeCloseTo(200);
    expect(100 * scale).toBeLessThan(200);
  });

  it('applies the same uniform scale to both axes (no independent width/height stretch)', () => {
    const scale = containScale(520, 1306, 300, 300);
    // A single scalar necessarily preserves the source aspect ratio — this is what the old
    // `art.width = art.height = imgSize` code broke.
    expect((520 * scale) / (1306 * scale)).toBeCloseTo(520 / 1306);
  });

  it('fits a non-square box (CardScene.drawArtFit path) the same way', () => {
    const scale = containScale(560, 1030, 200, 260);
    expect(scale).toBeCloseTo(Math.min(200 / 560, 260 / 1030));
  });
});
