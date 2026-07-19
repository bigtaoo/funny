// Unit tests for cards.ts: applyFusion / cardPower / selectBestCard (CHARACTER_CARDS_DESIGN §3/§2.4/§9).
import { describe, it, expect } from 'vitest';
import {
  CARD_DEFS,
  MAX_CARD_LEVEL,
  FUSION_MATERIAL_COUNT,
  applyFusion,
  cardPower,
  selectBestCard,
} from '../src/cards';
import type { CardInstance } from '../src/types';
import type { EquipmentInstance } from '../src/types';

// ── Helpers ─────────────────────────────────────────────────────────────────────

function makeCard(defId: string, level: number, gear: CardInstance['gear'] = {}): CardInstance {
  return { id: `test_${defId}_${level}`, defId, level, gear, locked: false };
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

// ── applyFusion ──────────────────────────────────────────────────────────────────

describe('applyFusion', () => {
  it('raises the card exactly one level', () => {
    const fused = applyFusion(makeCard('lichuang', 3));
    expect(fused.level).toBe(4);
  });

  it('is a no-op at MAX_CARD_LEVEL', () => {
    const maxed = makeCard('lichuang', MAX_CARD_LEVEL);
    expect(applyFusion(maxed)).toBe(maxed);
  });

  it('does not mutate the input card', () => {
    const card = makeCard('lichuang', 2);
    const fused = applyFusion(card);
    expect(card.level).toBe(2);
    expect(fused).not.toBe(card);
  });

  it('FUSION_MATERIAL_COUNT is 5', () => {
    expect(FUSION_MATERIAL_COUNT).toBe(5);
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
    const card = makeCard('lichuang', 5, { weapon: 'e1' });
    const noEquip = cardPower(makeCard('lichuang', 5), {});
    const withEquip = cardPower(card, { e1: equip });
    expect(withEquip).toBeGreaterThan(noEquip);
  });

  it('missing equipment instance in inv is silently ignored', () => {
    const card = makeCard('lichuang', 5, { weapon: 'nonexistent' });
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
    const noEquip = makeCard('lichuang', 9, {});
    const withEquip = makeCard('lichuang', 1, { weapon: 'e1' });
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
