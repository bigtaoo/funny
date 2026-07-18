// Regression coverage for sortCards (Hero Roster ordering): highest level first (level is the headline
// stat, shown as a star row), then — within one level — cards stay grouped by hero (CARD_DEFS
// declaration order) so duplicate instances of the same hero sit together, then power desc, then id.
import { describe, it, expect } from 'vitest';
import { sortCards } from '../src/scenes/CardScene/base';
import type { CardInstance } from '../src/game/meta/SaveData';

function makeCard(id: string, defId: string, level: number): CardInstance {
  return { id, defId, level, xp: 0, gear: {}, locked: false };
}

describe('sortCards', () => {
  it('sorts by level desc first, grouping by hero within a level', () => {
    // Interleaved input: two heroes (max, lichuang) whose instances have overlapping levels.
    const cards = [
      makeCard('a', 'max', 3),
      makeCard('b', 'lichuang', 5),
      makeCard('c', 'max', 5),
      makeCard('d', 'lichuang', 1),
      makeCard('e', 'max', 1),
    ];
    const sorted = sortCards(cards, {});
    // Level desc is the primary key. Within level 5, lichuang precedes max (declaration order).
    expect(sorted.map((c) => c.id)).toEqual(['b', 'c', 'a', 'd', 'e']);
    expect(sorted.map((c) => c.level)).toEqual([5, 5, 3, 1, 1]);
  });

  it('breaks ties by id when level, power, and hero are equal', () => {
    const cards = [makeCard('z', 'max', 3), makeCard('y', 'max', 3), makeCard('x', 'max', 3)];
    const sorted = sortCards(cards, {});
    expect(sorted.map((c) => c.id)).toEqual(['x', 'y', 'z']);
  });

  it('orders same-level cards by CARD_DEFS declaration order, not input order', () => {
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
