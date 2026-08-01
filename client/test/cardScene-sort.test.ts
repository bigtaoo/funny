// Regression coverage for sortCards (Hero Roster ordering): cards deployed to an SLG team come first,
// then the rest (2026-08-01). Within each group: highest combat power first, then — for equal power —
// level desc, then hero (CARD_DEFS declaration order) so duplicate instances of the same hero sit
// together, then id.
import { describe, it, expect } from 'vitest';
import { sortCards } from '../src/scenes/CardScene/base';
import type { CardInstance, EquipmentInstance } from '../src/game/meta/SaveData';
import type { CardSLGState } from '../src/net/WorldApiClient';

function makeCard(id: string, defId: string, level: number, gear: CardInstance['gear'] = {}): CardInstance {
  return { id, defId, level, gear, locked: false };
}

/** A weapon whose affix bonus alone can outweigh several card levels' worth of base power. */
function makeWeapon(id: string, affixValue: number): EquipmentInstance {
  return { id, defId: 'sword', rarity: 'epic', level: 0, affixes: [{ id: 'atk_pct', value: affixValue }] };
}

function deployed(teamId: string): CardSLGState {
  return { currentTroops: 0, injuredUntil: 0, teamId };
}

describe('sortCards', () => {
  it('sorts by level desc first, grouping by hero within a level, when nothing is deployed', () => {
    // Interleaved input: two heroes (max, lichuang) whose instances have overlapping levels.
    const cards = [
      makeCard('a', 'max', 3),
      makeCard('b', 'lichuang', 5),
      makeCard('c', 'max', 5),
      makeCard('d', 'lichuang', 1),
      makeCard('e', 'max', 1),
    ];
    const sorted = sortCards(cards, {});
    // Level desc is the primary key within the (single, all-not-deployed) group. Within level 5,
    // lichuang precedes max (declaration order).
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

  it('puts every deployed card ahead of every not-deployed card, regardless of level', () => {
    // 'weak' is deployed but much lower level than the two not-deployed cards — it must still lead.
    const cards = [
      makeCard('strong', 'max', 5),
      makeCard('mid', 'lichuang', 3),
      makeCard('weak', 'suyuan', 1),
    ];
    const cardState = { weak: deployed('t1') };
    const sorted = sortCards(cards, {}, cardState);
    expect(sorted.map((c) => c.id)).toEqual(['weak', 'strong', 'mid']);
  });

  it('sorts by combat power desc, not level — a heavily-geared low-level card outranks a bare high-level one', () => {
    // Bare cardPower is level-only (every CARD_DEFS entry's hp/atk powerWeights sum to 1.0 — see
    // cardDefs.ts), so this needs an equipment bonus to actually decouple power from level: a lvl-1
    // card with a +100% affix roughly doubles its power, comfortably past a bare lvl-5 card's ~1.44x.
    const cards = [makeCard('high-level-bare', 'max', 5), makeCard('low-level-geared', 'max', 1, { weapon: 'w1' })];
    const equipInv = { w1: makeWeapon('w1', 100) };
    const sorted = sortCards(cards, equipInv);
    expect(sorted.map((c) => c.id)).toEqual(['low-level-geared', 'high-level-bare']);
  });

  it('treats a card with no cardState entry as not-deployed', () => {
    const cards = [makeCard('a', 'max', 1), makeCard('b', 'lichuang', 1)];
    const cardState = { b: deployed('t1') };
    const sorted = sortCards(cards, {}, cardState);
    expect(sorted[0].id).toBe('b'); // only 'b' has an entry, and it's deployed
    expect(sorted[1].id).toBe('a');
  });
});
