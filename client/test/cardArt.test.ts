// Regression coverage for the Hero Roster "Skins" tab bug (2026-08-01): equipping a skin didn't
// change the character card's portrait because UNIT_ART_URLS was keyed only by unitType, ignoring
// the equipped skin entirely. unitPortraitUrl() is the fix — the single skin-aware resolver every
// portrait call site (skins.ts, detail.ts) must go through.
import { describe, it, expect } from 'vitest';
import { UNIT_ART_URLS, SKIN_PORTRAIT_ART, unitPortraitUrl } from '../src/render/cardArt';
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
