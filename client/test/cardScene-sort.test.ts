// Regression coverage for sortCards (Hero Roster ordering): cards deployed to an SLG team come first,
// then the rest (2026-08-01). Within each group: highest combat power first, then — for equal power —
// level desc, then hero (CARD_DEFS declaration order) so duplicate instances of the same hero sit
// together, then id.
import { describe, it, expect } from 'vitest';
import { sortCards, injuryCountdown } from '../src/scenes/CardScene/logic/cardSort';
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

  it('breaks a full power+level tie by CARD_DEFS order, then by id — the grid needs a TOTAL order', () => {
    // The last two rungs of the comparator (DEF_ORDER, then id) had no test: reachable because bare
    // cardPower is level-only, so two different heroes at the same level tie on both power and level.
    // Not cosmetic — ListPanel.renderList stores `order: sorted.map(c => c.id)` and syncCells places
    // cells by index into it. A comparator that returned 0 for a tie leaves the order at the mercy of
    // Array#sort's input order, so an unrelated cardInv key reshuffle would silently move cells.
    const cards = [
      makeCard('z-lichuang', 'lichuang', 3),
      makeCard('b-max', 'max', 3),
      makeCard('a-lichuang', 'lichuang', 3),
    ];
    const sorted = sortCards(cards, {});
    // 'lichuang' is CARD_DEFS' first entry and 'max' its fourth, so both lichuang instances lead
    // regardless of id; they then fall to the id tiebreak, ascending.
    expect(sorted.map((c) => c.id)).toEqual(['a-lichuang', 'z-lichuang', 'b-max']);
  });

  it('is order-stable: the same set in a different input order sorts identically', () => {
    // The direct consequence of the total order above, and the property renderList actually relies on.
    const cards = [
      makeCard('a-lichuang', 'lichuang', 3),
      makeCard('b-max', 'max', 3),
      makeCard('z-lichuang', 'lichuang', 3),
      makeCard('c-max', 'max', 5),
    ];
    const forward = sortCards(cards, {}).map((c) => c.id);
    const reversed = sortCards([...cards].reverse(), {}).map((c) => c.id);
    expect(reversed).toEqual(forward);
  });

  it('treats a card with no cardState entry as not-deployed', () => {
    const cards = [makeCard('a', 'max', 1), makeCard('b', 'lichuang', 1)];
    const cardState = { b: deployed('t1') };
    const sorted = sortCards(cards, {}, cardState);
    expect(sorted[0].id).toBe('b'); // only 'b' has an entry, and it's deployed
    expect(sorted[1].id).toBe('a');
  });
});

/**
 * injuryCountdown was the whole uncovered half of cardSort.ts when the module moved into
 * CardScene/logic/ (ADR-071 4b, 2026-08-27) — 0 of its 3 lines, because its only callers are
 * rosterCell.ts and detail.ts, both PIXI-bearing and therefore only exercised from test/ui/, which
 * reports no coverage.
 *
 * The 60-second boundary is not cosmetic. rosterCell.ts's cellSignature() puts this STRING in the
 * cell signature (not the raw deadline) precisely so an injured cell rebuilds once per displayed
 * minute instead of on every tick — so `ceil` vs `floor` here is the difference between the label
 * reading one minute short for a whole minute, and the seconds branch flipping at the wrong tick is
 * a per-frame cell rebuild for every injured card on screen.
 */
describe('injuryCountdown', () => {
  it('reads out whole seconds below one minute', () => {
    expect(injuryCountdown(30_000, 0)).toBe('30s');
    expect(injuryCountdown(1_000, 0)).toBe('1s');
  });

  it('rounds partial seconds UP, so a countdown never shows 0s while time remains', () => {
    expect(injuryCountdown(1, 0)).toBe('1s');
    expect(injuryCountdown(30_400, 0)).toBe('31s');
  });

  it('switches to minutes at exactly 60s, and 60s reads as 1m rather than 60s', () => {
    expect(injuryCountdown(59_000, 0)).toBe('59s');
    expect(injuryCountdown(60_000, 0)).toBe('1m');
  });

  it('rounds minutes UP too — 61s is "2m", not "1m"', () => {
    // Deliberate and worth pinning: the label is time REMAINING, so rounding down would show 1m for
    // 61 seconds and then sit at "1m" while a whole minute drains. The cost is that a fresh 5m injury
    // reads 5m for one second and then 5m again — harmless — while the last minute counts 1m -> 59s.
    expect(injuryCountdown(61_000, 0)).toBe('2m');
    expect(injuryCountdown(119_000, 0)).toBe('2m');
    expect(injuryCountdown(120_000, 0)).toBe('2m');
    expect(injuryCountdown(121_000, 0)).toBe('3m');
  });

  it('clamps an already-expired deadline to 0s instead of going negative', () => {
    // Callers gate on `injuredUntil > now` before asking, but a clock that steps backwards (server
    // clock resync, see net/serverClock.ts) can land here with now past the deadline mid-frame.
    expect(injuryCountdown(0, 5_000)).toBe('0s');
    expect(injuryCountdown(1_000, 999_999)).toBe('0s');
  });

  it('is a pure function of the gap, not of absolute time', () => {
    // Same remaining gap at two wildly different epochs must give the same string — the cell
    // signature depends on it (a signature that drifts with wall-clock alone would rebuild forever).
    expect(injuryCountdown(1_700_000_090_000, 1_700_000_000_000)).toBe('2m');
    expect(injuryCountdown(90_000, 0)).toBe('2m');
  });
});
