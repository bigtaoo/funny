// Pure-logic unit tests for the Hero Roster card math (CHARACTER_CARDS_DESIGN §2–3).
// These functions back CardScene (roster list/detail) but have no PIXI dependency, so they
// live in the default game-logic suite. Added alongside the 2026-07-07 CardScene split.
import { describe, it, expect } from 'vitest';
import {
  CARD_DEFS, LEVEL_CUMULATIVE_XP, getCardDef,
  xpToNextLevel, troopCap, cardPower, feedXp,
} from '../src/game/meta/cardDefs';
import type { CardInstance, EquipmentInstance } from '../src/game/meta/SaveData';

function card(partial: Partial<CardInstance> & { defId: string }): CardInstance {
  return { id: 'c1', level: 1, xp: 0, gear: {}, locked: false, ...partial };
}

describe('xpToNextLevel', () => {
  it('is 5^level below max level', () => {
    expect(xpToNextLevel(1)).toBe(5);
    expect(xpToNextLevel(2)).toBe(25);
    expect(xpToNextLevel(8)).toBe(5 ** 8);
  });

  it('is Infinity at and beyond max level 9', () => {
    expect(xpToNextLevel(9)).toBe(Infinity);
    expect(xpToNextLevel(99)).toBe(Infinity);
  });
});

describe('LEVEL_CUMULATIVE_XP', () => {
  it('is strictly increasing from level 1 through 9', () => {
    for (let i = 1; i < 9; i++) {
      expect(LEVEL_CUMULATIVE_XP[i + 1]).toBeGreaterThan(LEVEL_CUMULATIVE_XP[i]);
    }
  });
});

describe('feedXp', () => {
  it('adds in-level xp to the cumulative floor for the current level', () => {
    expect(feedXp(card({ defId: 'lichuang', level: 3, xp: 10 }))).toBe(LEVEL_CUMULATIVE_XP[3] + 10);
  });

  it('clamps level into 1..9 and floors negative xp to 0', () => {
    expect(feedXp(card({ defId: 'lichuang', level: 99, xp: -5 }))).toBe(LEVEL_CUMULATIVE_XP[9]);
    expect(feedXp(card({ defId: 'lichuang', level: 0, xp: 3 }))).toBe(LEVEL_CUMULATIVE_XP[1] + 3);
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
