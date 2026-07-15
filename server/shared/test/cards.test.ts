// Unit tests for cards.ts: feedXp / cardPower / selectBestCard (CHARACTER_CARDS_DESIGN §3/§2.4/§9).
import { describe, it, expect } from 'vitest';
import {
  CARD_DEFS,
  LEVEL_CUMULATIVE_XP,
  feedXp,
  cardPower,
  selectBestCard,
} from '../src/cards';
import type { CardInstance } from '../src/types';
import type { EquipmentInstance } from '../src/types';

// ── Helpers ─────────────────────────────────────────────────────────────────────

function makeCard(defId: string, level: number, xp = 0, gear: CardInstance['gear'] = {}): CardInstance {
  return { id: `test_${defId}_${level}`, defId, level, xp, gear, locked: false };
}

function makeEquip(id: string, mainAffixValue: number): EquipmentInstance {
  return {
    id,
    defId: 'wp_pencil',
    rarity: 'common',
    level: 0,
    affixes: [{ id: 'm_atk', value: mainAffixValue }],
  };
}

// ── CARD_DEFS sanity ─────────────────────────────────────────────────────────────

describe('CARD_DEFS', () => {
  it('has exactly 6 cards', () => {
    expect(Object.keys(CARD_DEFS)).toHaveLength(6);
  });

  it('maps Tao cards to correct unit types', () => {
    expect(CARD_DEFS['lichuang']?.unitType).toBe('infantry');
    expect(CARD_DEFS['chenshou']?.unitType).toBe('shieldbearer');
    expect(CARD_DEFS['suyuan']?.unitType).toBe('archer');
  });

  it('maps Anna cards to correct unit types', () => {
    expect(CARD_DEFS['max']?.unitType).toBe('max');
    expect(CARD_DEFS['lena']?.unitType).toBe('lena');
    expect(CARD_DEFS['mara']?.unitType).toBe('mara');
  });

  it('Tao cards have no skill (all zeros)', () => {
    for (const id of ['lichuang', 'chenshou', 'suyuan']) {
      const def = CARD_DEFS[id]!;
      expect(def.skillGrowth.every((v) => v === 0)).toBe(true);
    }
  });

  it('Anna cards have non-zero skill at level 3+', () => {
    for (const id of ['max', 'lena', 'mara']) {
      const def = CARD_DEFS[id]!;
      expect(def.skillGrowth[2]).toBeGreaterThan(0); // index 2 = level 3
    }
  });

  it('powerWeights sum to 1 for all cards', () => {
    for (const def of Object.values(CARD_DEFS)) {
      expect(def.powerWeights.hp + def.powerWeights.atk).toBeCloseTo(1, 5);
    }
  });
});

// ── LEVEL_CUMULATIVE_XP ──────────────────────────────────────────────────────────

describe('LEVEL_CUMULATIVE_XP', () => {
  it('has 10 entries (index 0..9)', () => {
    expect(LEVEL_CUMULATIVE_XP).toHaveLength(10);
  });

  it('level 1 cumulative XP is 0 (starting state)', () => {
    expect(LEVEL_CUMULATIVE_XP[1]).toBe(0);
  });

  it('follows cost(n→n+1) = 5^n formula', () => {
    // L1→L2 costs 5^1 = 5  →  cumXP[2] - cumXP[1] = 5
    expect(LEVEL_CUMULATIVE_XP[2]! - LEVEL_CUMULATIVE_XP[1]!).toBe(5);
    // L2→L3 costs 5^2 = 25  →  cumXP[3] - cumXP[2] = 25
    expect(LEVEL_CUMULATIVE_XP[3]! - LEVEL_CUMULATIVE_XP[2]!).toBe(25);
    // L8→L9 costs 5^8 = 390625
    expect(LEVEL_CUMULATIVE_XP[9]! - LEVEL_CUMULATIVE_XP[8]!).toBe(390625);
  });

  it('level 9 cumulative is ~488k', () => {
    expect(LEVEL_CUMULATIVE_XP[9]).toBe(488280);
  });
});

// ── feedXp ───────────────────────────────────────────────────────────────────────

describe('feedXp', () => {
  it('level 1, xp=0 → 1 (base currency unit, no loss)', () => {
    expect(feedXp(makeCard('lichuang', 1, 0))).toBe(1);
  });

  it('level 1, xp=3 → 4 (base + partial XP progress, no loss)', () => {
    expect(feedXp(makeCard('lichuang', 1, 3))).toBe(4);
  });

  it('level 2, xp=0 → 4 (cost of L1→L2 = 5, at 80% efficiency)', () => {
    expect(feedXp(makeCard('lichuang', 2, 0))).toBe(4);
  });

  it('level 2, xp=10 → 12 (level cost + partial progress, at 80% efficiency)', () => {
    expect(feedXp(makeCard('lichuang', 2, 10))).toBe(12);
  });

  it('level 9, xp=0 → 390624 (full max investment, at 80% efficiency)', () => {
    expect(feedXp(makeCard('lichuang', 9, 0))).toBe(390624);
  });

  it('clamps level below 1 to 1', () => {
    expect(feedXp(makeCard('lichuang', 0, 0))).toBe(1); // level clamped to 1, xp 0 → base value 1
  });

  it('clamps level above 9 to 9', () => {
    expect(feedXp(makeCard('lichuang', 10, 0))).toBe(390624);
  });

  it('ignores negative xp (treated as 0)', () => {
    expect(feedXp(makeCard('lichuang', 1, -5))).toBe(1);
  });
});

// ── cardPower ────────────────────────────────────────────────────────────────────

describe('cardPower', () => {
  it('returns 0 for unknown defId', () => {
    expect(cardPower(makeCard('unknown_def', 1), {})).toBe(0);
  });

  it('level 1 card has positive power', () => {
    expect(cardPower(makeCard('lichuang', 1), {})).toBeGreaterThan(0);
  });

  it('higher level → higher power (monotone for same unit type)', () => {
    const p1 = cardPower(makeCard('lichuang', 1), {});
    const p5 = cardPower(makeCard('lichuang', 5), {});
    const p9 = cardPower(makeCard('lichuang', 9), {});
    expect(p5).toBeGreaterThan(p1);
    expect(p9).toBeGreaterThan(p5);
  });

  it('equipment bonus increases power', () => {
    const equip = makeEquip('e1', 30); // m_atk +30%
    const card = makeCard('lichuang', 5, 0, { weapon: 'e1' });
    const noEquip = cardPower(makeCard('lichuang', 5), {});
    const withEquip = cardPower(card, { e1: equip });
    expect(withEquip).toBeGreaterThan(noEquip);
  });

  it('missing equipment instance in inv is silently ignored', () => {
    const card = makeCard('lichuang', 5, 0, { weapon: 'nonexistent' });
    expect(cardPower(card, {})).toBeCloseTo(cardPower(makeCard('lichuang', 5), {}), 5);
  });
});

// ── selectBestCard ────────────────────────────────────────────────────────────────

describe('selectBestCard', () => {
  it('returns undefined when no card of that unit type exists', () => {
    const cardInv: Record<string, CardInstance> = {
      a: makeCard('lichuang', 5), // infantry
    };
    expect(selectBestCard('shieldbearer', cardInv)).toBeUndefined();
  });

  it('returns the only card when there is exactly one', () => {
    const card = makeCard('lichuang', 5);
    const cardInv = { a: card };
    expect(selectBestCard('infantry', cardInv)).toBe(card);
  });

  it('returns the higher-level card when multiple exist', () => {
    const low = makeCard('lichuang', 3);
    const high = makeCard('lichuang', 7);
    const cardInv = { a: low, b: high };
    expect(selectBestCard('infantry', cardInv)).toBe(high);
  });

  it('ignores cards of a different unit type', () => {
    const infantry = makeCard('lichuang', 9);
    const shieldbearer = makeCard('chenshou', 5);
    const cardInv = { a: infantry, b: shieldbearer };
    expect(selectBestCard('shieldbearer', cardInv)).toBe(shieldbearer);
  });

  it('considers equipment when ranking (higher-level card with no equipment vs lower-level with large bonus)', () => {
    // This test documents the expected behaviour, not a correctness requirement for the formula.
    const noEquip = makeCard('lichuang', 9, 0, {});
    const withEquip = makeCard('lichuang', 1, 0, { weapon: 'e1' });
    const equip = makeEquip('e1', 9999); // absurdly high bonus to ensure it wins
    const cardInv = { a: noEquip, b: withEquip };
    const best = selectBestCard('infantry', cardInv, { e1: equip });
    expect(best).toBe(withEquip); // equipment bonus makes it the best
  });

  it('selects from Anna faction cards correctly', () => {
    const maxCard = makeCard('max', 4);
    const cardInv = { a: makeCard('lichuang', 9), b: maxCard };
    expect(selectBestCard('max', cardInv)).toBe(maxCard);
  });
});
