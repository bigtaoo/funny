// Unit tests for the client-side title mirror (game/meta/titles.ts). Must stay in sync with the
// server authority @nw/shared/src/titles.ts — SLG season titles (slg.s{N}.{key}) were wired up
// alongside worldsvc SLG season settlement (TITLE_DESIGN §3, 2026-07-16).
import { describe, it, expect } from 'vitest';
import {
  titleWeight,
  getTitleKeys,
  formatSlgTitle,
  formatLadderTitle,
  sortTitlesByWeight,
  allTitleIds,
  TITLE_DEFS,
} from '../src/game/meta/titles';

describe('titleWeight (slg season titles)', () => {
  it('ranks champion above top3', () => {
    expect(titleWeight('slg.s2.champion')).toBeGreaterThan(titleWeight('slg.s2.top3'));
  });

  it('falls back to the T3 base for an unknown slg key', () => {
    expect(titleWeight('slg.s2.mystery')).toBe(3500);
  });

  it('returns 0 for a non-title string', () => {
    expect(titleWeight('garbage')).toBe(0);
  });
});

describe('getTitleKeys (slg season titles)', () => {
  it('maps a seasonal slg id to per-key i18n keys', () => {
    expect(getTitleKeys('slg.s3.champion')).toEqual({
      fullKey: 'title.slg.champion.full',
      shortKey: 'title.slg.champion.short',
    });
    expect(getTitleKeys('slg.s3.top3')).toEqual({
      fullKey: 'title.slg.top3.full',
      shortKey: 'title.slg.top3.short',
    });
  });

  it('still resolves ladder seasonal titles to the generic ladder keys', () => {
    expect(getTitleKeys('ladder.s3.gold')).toEqual({
      fullKey: 'title.ladder.full',
      shortKey: 'title.ladder.short',
    });
  });
});

describe('formatSlgTitle', () => {
  it('formats the season-stamped fallback text', () => {
    expect(formatSlgTitle('slg.s7.champion')).toBe('S7 champion');
  });

  it('returns the raw id for a non-slg id (ladder uses formatLadderTitle)', () => {
    expect(formatSlgTitle('ladder.s7.king')).toBe('ladder.s7.king');
    expect(formatLadderTitle('slg.s7.champion')).toBe('slg.s7.champion');
  });
});

// The two title-WALL helpers (2026-09-10 FNDA sweep: both at zero hits — TitlesScene and the
// settings avatar picker are their only callers, and neither is reachable from a `.test.ts`).
// They decide what the player sees on the titles screen, and both fail without erroring: a wrong
// order buries the prize the player just earned somewhere down the grid, and a catalogue that
// drops the fixed entries turns "here is what there is to earn" into "here is what you have",
// which is the change the 2026-07-16 pass explicitly made in the other direction.
describe('sortTitlesByWeight', () => {
  it('orders by descending weight, strongest first', () => {
    const sorted = sortTitlesByWeight(['ladder.s1.bronze', 'event.founder', 'ladder.s1.king']);
    expect(sorted).toEqual(['event.founder', 'ladder.s1.king', 'ladder.s1.bronze']);
    // Non-vacuity: the three genuinely differ in weight, so the order above is a real ranking.
    expect(new Set(sorted.map(titleWeight)).size).toBe(3);
  });

  it('does not mutate the caller’s array', () => {
    // TitlesScene passes `allTitleIds(this.cb.titles)`, but the avatar picker passes the save's
    // own owned-titles array straight through; sorting in place would silently reorder it.
    const input = ['ladder.s1.bronze', 'ladder.s1.king'];
    sortTitlesByWeight(input);
    expect(input).toEqual(['ladder.s1.bronze', 'ladder.s1.king']);
  });

  it('keeps equal-weight titles in their original order (stable)', () => {
    // Two unknown ids both weigh 0; a comparator returning a constant would be free to swap them.
    const sorted = sortTitlesByWeight(['zzz.unknown.a', 'zzz.unknown.b']);
    expect(sorted).toEqual(['zzz.unknown.a', 'zzz.unknown.b']);
  });

  it('handles the empty list', () => {
    expect(sortTitlesByWeight([])).toEqual([]);
  });
});

describe('allTitleIds', () => {
  it('always lists every fixed title, owned or not', () => {
    const ids = allTitleIds([]);
    expect(ids).toEqual(Object.keys(TITLE_DEFS));
    expect(ids.length).toBeGreaterThan(0); // non-vacuity: the fixed catalogue is not empty
  });

  it('appends the owned seasonal titles, which have no fixed catalogue to enumerate', () => {
    const ids = allTitleIds(['ladder.s2.gold', 'slg.s2.champion']);
    expect(ids).toContain('ladder.s2.gold');
    expect(ids).toContain('slg.s2.champion');
    expect(ids.slice(0, Object.keys(TITLE_DEFS).length)).toEqual(Object.keys(TITLE_DEFS));
  });

  it('does not list an owned FIXED title twice', () => {
    // The owned list contains fixed ids as well; without the filter the wall would show the
    // player's own event/achievement titles a second time at the end.
    const owned = [Object.keys(TITLE_DEFS)[0]!, 'ladder.s2.gold'];
    const ids = allTitleIds(owned);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
