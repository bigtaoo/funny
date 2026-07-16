// Regression coverage for sortCards grouping (Hero Roster visual-clutter fix, 2026-07-16): duplicate
// instances of the same hero used to interleave with other heroes at the same power/level, scattering
// same-named cards across the grid. sortCards now groups by hero (CARD_DEFS declaration order) first.
import { describe, it, expect } from 'vitest';
import { sortCards } from '../src/scenes/CardScene/base';
import type { CardInstance } from '../src/game/meta/SaveData';

function makeCard(id: string, defId: string, level: number): CardInstance {
  return { id, defId, level, xp: 0, gear: {}, locked: false };
}

describe('sortCards', () => {
  it('groups cards by hero (defId) before sorting by power/level within the group', () => {
    // Interleaved input: two heroes (max, lichuang) whose instances have overlapping levels.
    const cards = [
      makeCard('a', 'max', 3),
      makeCard('b', 'lichuang', 5),
      makeCard('c', 'max', 5),
      makeCard('d', 'lichuang', 1),
      makeCard('e', 'max', 1),
    ];
    const sorted = sortCards(cards, {});
    const defIdOrder = sorted.map((c) => c.defId);
    // lichuang precedes max in CARD_DEFS declaration order, so its group comes first.
    expect(defIdOrder).toEqual(['lichuang', 'lichuang', 'max', 'max', 'max']);
    // Within the lichuang group: level desc.
    const lichuangIds = sorted.filter((c) => c.defId === 'lichuang').map((c) => c.id);
    expect(lichuangIds).toEqual(['b', 'd']);
    // Within the max group: level desc.
    const maxIds = sorted.filter((c) => c.defId === 'max').map((c) => c.id);
    expect(maxIds).toEqual(['c', 'a', 'e']);
  });

  it('breaks ties by id when power and level are equal within a group', () => {
    const cards = [makeCard('z', 'max', 3), makeCard('y', 'max', 3), makeCard('x', 'max', 3)];
    const sorted = sortCards(cards, {});
    expect(sorted.map((c) => c.id)).toEqual(['x', 'y', 'z']);
  });

  it('orders every hero group by CARD_DEFS declaration order, not input order', () => {
    // Input deliberately reverse of CARD_DEFS declaration order (mara, lena, max, suyuan, chenshou, lichuang).
    const cards = ['mara', 'lena', 'max', 'suyuan', 'chenshou', 'lichuang'].map((defId, i) =>
      makeCard(`c${i}`, defId, 1),
    );
    const sorted = sortCards(cards, {});
    expect(sorted.map((c) => c.defId)).toEqual(['lichuang', 'chenshou', 'suyuan', 'max', 'lena', 'mara']);
  });

  it('does not mutate the input array', () => {
    const cards = [makeCard('a', 'max', 1), makeCard('b', 'lichuang', 1)];
    const original = [...cards];
    sortCards(cards, {});
    expect(cards).toEqual(original);
  });

  it('returns an empty array for an empty roster', () => {
    expect(sortCards([], {})).toEqual([]);
  });
});
