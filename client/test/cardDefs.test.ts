// Pure-logic unit tests for the Hero Roster card math (CHARACTER_CARDS_DESIGN §2–3).
// These functions back CardScene (roster list/detail) but have no PIXI dependency, so they
// live in the default game-logic suite. Added alongside the 2026-07-07 CardScene split.
import { describe, it, expect } from 'vitest';
import {
  CARD_DEFS, MAX_CARD_LEVEL, FUSION_MATERIAL_COUNT, getCardDef,
  troopCap, cardPower, fusionMaterialCandidates,
} from '../src/game/meta/cardDefs';
import type { CardInstance, EquipmentInstance } from '../src/game/meta/SaveData';

function card(partial: Partial<CardInstance> & { defId: string }): CardInstance {
  return { id: 'c1', level: 1, gear: {}, locked: false, ...partial };
}

describe('fusionMaterialCandidates', () => {
  it('includes only unlocked same-faction same-level cards, excluding the target itself', () => {
    const target = card({ id: 'target', defId: 'lichuang', level: 3 });
    const inv: Record<string, CardInstance> = {
      target,
      wrongLevel: card({ id: 'wrongLevel', defId: 'chenshou', level: 2 }),
      wrongFaction: card({ id: 'wrongFaction', defId: 'max', level: 3 }),
      locked: card({ id: 'locked', defId: 'suyuan', level: 3, locked: true }),
      eligible: card({ id: 'eligible', defId: 'chenshou', level: 3 }),
    };
    const candidates = fusionMaterialCandidates(target, inv);
    expect(candidates.map((c) => c.id)).toEqual(['eligible']);
  });

  it('respects FUSION_MATERIAL_COUNT as the number of slots a fusion needs', () => {
    expect(FUSION_MATERIAL_COUNT).toBe(5);
  });
});

describe('troopCap', () => {
  it('scales as base + growth * (level - 1)', () => {
    expect(troopCap(card({ defId: 'lichuang', level: 1 }))).toBe(200);
    expect(troopCap(card({ defId: 'lichuang', level: 2 }))).toBe(250);
    expect(troopCap(card({ defId: 'lichuang', level: 9 }))).toBe(200 + 50 * 8);
  });

  it('clamps level into 1..9', () => {
    expect(troopCap(card({ defId: 'lichuang', level: 0 }))).toBe(200);  // → level 1
    expect(troopCap(card({ defId: 'lichuang', level: 50 }))).toBe(600); // → level 9
  });

  it('returns 0 for an unknown defId', () => {
    expect(troopCap(card({ defId: 'does-not-exist', level: 5 }))).toBe(0);
  });
});

describe('cardPower', () => {
  it('scales monotonically with level and is 0 for an unknown def', () => {
    const p1 = cardPower(card({ defId: 'lichuang', level: 1 }));
    const p2 = cardPower(card({ defId: 'lichuang', level: 2 }));
    expect(p1).toBeCloseTo(100);        // (hp 0.4 + atk 0.6) * 100 * (1 + 0.11*0)
    expect(p2).toBeGreaterThan(p1);
    expect(cardPower(card({ defId: 'does-not-exist' }))).toBe(0);
  });

  it('applies equipped affix percent bonuses', () => {
    const inst: EquipmentInstance = {
      id: 'e1', defId: 'sword', rarity: 'common', level: 1, affixes: [{ id: 'atk', value: 10 }],
    };
    const withGear = card({ defId: 'lichuang', level: 1, gear: { weapon: 'e1' } });
    expect(cardPower(withGear, { e1: inst })).toBeCloseTo(110); // base 100 * (1 + 10/100)
  });

  it('ignores gear ids missing from the equipment inventory', () => {
    const withDangling = card({ defId: 'lichuang', level: 1, gear: { weapon: 'gone' } });
    expect(cardPower(withDangling, {})).toBeCloseTo(100);
  });
});

describe('getCardDef', () => {
  it('resolves known ids and returns undefined otherwise', () => {
    expect(getCardDef('lichuang')).toBe(CARD_DEFS.lichuang);
    expect(getCardDef('does-not-exist')).toBeUndefined();
  });
});
