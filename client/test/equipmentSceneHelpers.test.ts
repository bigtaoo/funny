// Direct unit coverage for EquipmentScene/helpers.ts's pure functions — previously exercised only
// indirectly through UI tests (see test/ui/*.ui.ts). affixDesc() in particular is where ADR-065
// shipped a live production bug: `value * enhanceMultiplier(level)` type-checked fine (Fp is
// structurally still `number`) but was 1000x too large, because enhanceMultiplier() returns an fp
// value and nothing forced a fromFp() unscale first. Pinning the exact scaled numbers here — not
// just "does it render something" — is what would have caught that bug at the source instead of
// relying on the full suite to surface it downstream.
import { describe, it, expect } from 'vitest';
import {
  affixDesc,
  itemLabel,
  materialsStr,
  equippedIds,
  stackSiblingIds,
  canAffordMaterials,
  canAffordEnhance,
} from '../src/scenes/EquipmentScene/helpers';
import type { EquipmentInstance, CardInstance } from '../src/game/meta/SaveData';
import { makeNewSave } from '../src/game/meta/SaveData';

function makeEquip(id: string, over: Partial<EquipmentInstance> = {}): EquipmentInstance {
  return { id, defId: 'sword', rarity: 'common', level: 0, affixes: [], ...over };
}

function makeCard(id: string, gear: CardInstance['gear'] = {}): CardInstance {
  return { id, defId: 'max', level: 0, gear, locked: false };
}

describe('affixDesc — main-affix level scaling (ADR-065 fp unscale)', () => {
  it('at level 0 (×1.00 multiplier), the raw value passes through unchanged', () => {
    // m_atk is a 'main' affix (affixKind: id starts with 'm_').
    expect(affixDesc('m_atk', 10, 0)).toBe('攻击 +10%');
  });

  it('at level 9 (×5.00, the current top multiplier), scales to exactly 5x — not 5000x', () => {
    // This is the exact regression the production bug would reintroduce: without fromFp()
    // unscaling enhanceMultiplier()'s fp return value, this would render "+50000" instead of "+50".
    expect(affixDesc('m_atk', 10, 9)).toBe('攻击 +50%');
  });

  it('at level 6 (the ×1.76 breakpoint), rounds to the nearest whole percent', () => {
    // 10 * 1.76 = 17.6 -> Math.round -> 18.
    expect(affixDesc('m_atk', 10, 6)).toBe('攻击 +18%');
  });

  it('sub-affixes (s_ prefix) are never level-scaled, unlike main affixes', () => {
    expect(affixDesc('s_atk', 10, 9)).toBe(affixDesc('s_atk', 10, 0));
    expect(affixDesc('s_atk', 10, 9)).toBe('攻击 +10%');
  });

  it('an unknown affix id without an i18n entry falls back to "<id> +<value>"', () => {
    expect(affixDesc('m_totally_unknown_id', 3, 0)).toBe('m_totally_unknown_id +3');
  });
});

describe('itemLabel', () => {
  it('omits stars entirely at level 0 (the common case)', () => {
    expect(itemLabel('sword', 0)).not.toMatch(/★/);
  });

  it('appends level stars when level > 0', () => {
    expect(itemLabel('sword', 3)).toMatch(/★/);
  });
});

describe('materialsStr', () => {
  it('formats each material as "<name>×<count>", space-joined', () => {
    const s = materialsStr({ wood: 3, stone: 5 });
    expect(s).toContain('×3');
    expect(s).toContain('×5');
  });

  it('is empty for an empty cost map', () => {
    expect(materialsStr({})).toBe('');
  });
});

describe('equippedIds', () => {
  it('collects every non-empty gear slot id across all cards', () => {
    const save = makeNewSave();
    save.cardInv = {
      a: makeCard('a', { weapon: 'w1', armor: 'ar1' }),
      b: makeCard('b', { weapon: 'w2' }),
    };
    expect(equippedIds(save)).toEqual(new Set(['w1', 'ar1', 'w2']));
  });

  it('is empty when no card has any gear equipped', () => {
    const save = makeNewSave();
    save.cardInv = { a: makeCard('a') };
    expect(equippedIds(save).size).toBe(0);
  });
});

describe('stackSiblingIds', () => {
  it('a locked instance is always its own row, regardless of siblings', () => {
    const save = makeNewSave();
    save.equipmentInv = {
      a: makeEquip('a', { locked: true }),
      b: makeEquip('b'),
    };
    expect(stackSiblingIds(save, save.equipmentInv.a!)).toEqual(['a']);
  });

  it('a leveled (>0) instance is always its own row, never merged into a stack', () => {
    const save = makeNewSave();
    save.equipmentInv = { a: makeEquip('a', { level: 2 }) };
    expect(stackSiblingIds(save, save.equipmentInv.a!)).toEqual(['a']);
  });

  it('an equipped +0 instance is its own row (equipped items are never stacked)', () => {
    const save = makeNewSave();
    save.equipmentInv = { a: makeEquip('a') };
    save.cardInv = { c: makeCard('c', { weapon: 'a' }) };
    expect(stackSiblingIds(save, save.equipmentInv.a!)).toEqual(['a']);
  });

  it('merges unlocked +0 unequipped instances sharing defId+rarity into one stack', () => {
    const save = makeNewSave();
    save.equipmentInv = {
      a: makeEquip('a'),
      b: makeEquip('b'),
      c: makeEquip('c', { defId: 'axe' }), // different defId -> not a sibling
      d: makeEquip('d', { rarity: 'epic' }), // different rarity -> not a sibling
    };
    expect(stackSiblingIds(save, save.equipmentInv.a!).sort()).toEqual(['a', 'b']);
  });
});

describe('canAffordMaterials / canAffordEnhance', () => {
  it('canAffordMaterials is true only when every required material meets the threshold', () => {
    const save = makeNewSave();
    save.materials = { wood: 5, stone: 2 };
    expect(canAffordMaterials(save, { wood: 5 })).toBe(true);
    expect(canAffordMaterials(save, { wood: 6 })).toBe(false);
    expect(canAffordMaterials(save, { wood: 5, stone: 2 })).toBe(true);
    expect(canAffordMaterials(save, { wood: 5, stone: 3 })).toBe(false);
  });

  it('canAffordEnhance requires both materials AND coins', () => {
    const save = makeNewSave();
    save.materials = { wood: 5 };
    save.wallet = { coins: 100 };
    expect(canAffordEnhance(save, { materials: { wood: 5 }, coins: 100 })).toBe(true);
    expect(canAffordEnhance(save, { materials: { wood: 5 }, coins: 101 })).toBe(false);
    expect(canAffordEnhance(save, { materials: { wood: 6 }, coins: 100 })).toBe(false);
  });
});
