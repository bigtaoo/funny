// Pure-logic tests for the per-character skin equip model (LOBBY_IA_REDESIGN §15 / ADR-038):
// skins used to live on a single global SaveData.equipped[EQUIP_SLOT] slot; now each character has its
// own slot, so several skins can be equipped simultaneously.
import { describe, it, expect } from 'vitest';
import { SKIN_TARGET_UNIT, skinsForUnitType, skinEquipKey, allEquippedSkins } from '../src/game/meta/skinDefs';
import { UnitType } from '../src/game/types';

describe('SKIN_TARGET_UNIT', () => {
  it('maps every catalogue skin to exactly one unit type', () => {
    expect(SKIN_TARGET_UNIT.skin_shop_c1).toBe(UnitType.Infantry);
    expect(SKIN_TARGET_UNIT.skin_shop_r1).toBe(UnitType.Archer);
    expect(SKIN_TARGET_UNIT.skin_shop_e1).toBe(UnitType.ShieldBearer);
    expect(SKIN_TARGET_UNIT.skin_e1).toBe(UnitType.Lena);
    expect(SKIN_TARGET_UNIT.skin_e2).toBe(UnitType.Mara);
    expect(SKIN_TARGET_UNIT.skin_l1).toBe(UnitType.Max);
  });
});

describe('skinsForUnitType', () => {
  it('filters an owned-skins list down to the ones matching a character', () => {
    const owned = ['skin_e1', 'skin_l1', 'skin_shop_c1'];
    expect(skinsForUnitType(UnitType.Lena, owned)).toEqual(['skin_e1']);
    expect(skinsForUnitType(UnitType.Max, owned)).toEqual(['skin_l1']);
    expect(skinsForUnitType(UnitType.Mara, owned)).toEqual([]);
  });
});

describe('skinEquipKey', () => {
  it('namespaces the slot key so it never collides with the title slot', () => {
    expect(skinEquipKey(UnitType.Lena)).toBe('skin:lena');
    expect(skinEquipKey(UnitType.Lena)).not.toBe('title');
  });
});

describe('allEquippedSkins', () => {
  it('extracts only skin: keys, ignoring the unrelated title slot', () => {
    const equipped = { title: 'champion', 'skin:lena': 'skin_e1', 'skin:max': 'skin_l1' };
    expect(allEquippedSkins(equipped).sort()).toEqual(['skin_e1', 'skin_l1']);
  });

  it('returns an empty array when nothing is equipped', () => {
    expect(allEquippedSkins({})).toEqual([]);
  });
});
