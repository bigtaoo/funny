// Unit tests for titles.ts: weight lookup (static + dynamic seasonal), auto-equip grant logic, id parsing
// (TITLE_DESIGN.md §6). Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  LADDER_RANK_WEIGHTS,
  SLG_TITLE_WEIGHTS,
  TITLE_DEFS,
  titleWeight,
  titleShortKey,
  grantTitle,
  ladderTitleId,
  slgTitleId,
  parseTitleId,
} from '../src/titles';
import type { RankId } from '../src/ladder';

// ── LADDER_RANK_WEIGHTS ───────────────────────────────────────────────────────────

describe('LADDER_RANK_WEIGHTS', () => {
  const order: RankId[] = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'star', 'master', 'grandmaster', 'king'];

  it('weights increase up the ladder', () => {
    for (let i = 1; i < order.length; i++) {
      expect(LADDER_RANK_WEIGHTS[order[i]!]).toBeGreaterThan(LADDER_RANK_WEIGHTS[order[i - 1]!]);
    }
  });
});

// ── titleWeight ───────────────────────────────────────────────────────────────────

describe('titleWeight', () => {
  it('resolves a static table title', () => {
    expect(titleWeight('event.founder')).toBe(TITLE_DEFS['event.founder']!.weight);
  });

  it('derives a dynamic ladder seasonal title from the rank weight', () => {
    expect(titleWeight('ladder.s5.diamond')).toBe(LADDER_RANK_WEIGHTS.diamond);
  });

  it('gives an SLG seasonal title with an unknown key the fallback T3 weight', () => {
    expect(titleWeight('slg.s2.conqueror')).toBe(3500);
  });

  it('resolves known SLG tier keys and ranks champion above top3', () => {
    expect(titleWeight('slg.s2.champion')).toBe(SLG_TITLE_WEIGHTS.champion);
    expect(titleWeight('slg.s2.top3')).toBe(SLG_TITLE_WEIGHTS.top3);
    expect(titleWeight('slg.s2.champion')).toBeGreaterThan(titleWeight('slg.s2.top3'));
  });

  it('returns 0 for an unknown title', () => {
    expect(titleWeight('garbage')).toBe(0);
  });

  it('returns 0 for a ladder title with an unknown rank', () => {
    expect(titleWeight('ladder.s1.mythic')).toBe(0);
  });
});

// ── titleShortKey ─────────────────────────────────────────────────────────────────

describe('titleShortKey', () => {
  it('resolves a static table short key', () => {
    expect(titleShortKey('event.founder')).toBe(TITLE_DEFS['event.founder']!.shortKey);
  });

  it('returns the generic ladder short key for a seasonal ladder title', () => {
    expect(titleShortKey('ladder.s3.gold')).toBe('title.ladder.short');
  });

  it('returns the per-key slg short key for a seasonal slg title', () => {
    expect(titleShortKey('slg.s3.champion')).toBe('title.slg.champion.short');
    expect(titleShortKey('slg.s3.top3')).toBe('title.slg.top3.short');
  });

  it('returns empty for unknown', () => {
    expect(titleShortKey('garbage')).toBe('');
  });
});

// ── grantTitle ────────────────────────────────────────────────────────────────────

describe('grantTitle', () => {
  it('auto-equips the first title when none is equipped', () => {
    const r = grantTitle([], undefined, 'event.newbie');
    expect(r.titles).toEqual(['event.newbie']);
    expect(r.equippedTitle).toBe('event.newbie');
  });

  it('appends a new title and equips it when it outranks the current', () => {
    const r = grantTitle(['event.newbie'], 'event.newbie', 'event.founder'); // 6300 > 1300
    expect(r.titles).toEqual(['event.newbie', 'event.founder']);
    expect(r.equippedTitle).toBe('event.founder');
  });

  it('keeps the current equip when the new title ranks lower', () => {
    const r = grantTitle(['event.founder'], 'event.founder', 'event.newbie'); // 1300 < 6300
    expect(r.titles).toContain('event.newbie');
    expect(r.equippedTitle).toBe('event.founder');
  });

  it('is idempotent on re-grant of an owned title (no duplicate)', () => {
    const r = grantTitle(['event.founder'], 'event.founder', 'event.founder');
    expect(r.titles).toEqual(['event.founder']);
    expect(r.equippedTitle).toBe('event.founder');
  });

  it('equips the newer title on a weight tie when newly acquired', () => {
    // two ladder titles of the same rank/weight in different seasons
    const a = 'ladder.s1.gold';
    const b = 'ladder.s2.gold';
    expect(titleWeight(a)).toBe(titleWeight(b));
    const r = grantTitle([a], a, b);
    expect(r.equippedTitle).toBe(b);
  });
});

// ── ladderTitleId / parseTitleId ──────────────────────────────────────────────────

describe('ladderTitleId', () => {
  it('assembles the seasonal id', () => {
    expect(ladderTitleId(7, 'diamond')).toBe('ladder.s7.diamond');
  });

  it('round-trips through titleWeight', () => {
    expect(titleWeight(ladderTitleId(4, 'king'))).toBe(LADDER_RANK_WEIGHTS.king);
  });
});

describe('slgTitleId', () => {
  it('assembles the seasonal id', () => {
    expect(slgTitleId(3, 'champion')).toBe('slg.s3.champion');
  });

  it('round-trips through titleWeight (champion outranks top3)', () => {
    expect(titleWeight(slgTitleId(3, 'champion'))).toBe(SLG_TITLE_WEIGHTS.champion);
    expect(titleWeight(slgTitleId(3, 'top3'))).toBe(SLG_TITLE_WEIGHTS.top3);
  });

  it('round-trips through parseTitleId', () => {
    expect(parseTitleId(slgTitleId(9, 'champion'))).toEqual({ source: 'slg', seasonNo: 9 });
  });
});

describe('parseTitleId', () => {
  it('parses ladder seasonal ids with season number', () => {
    expect(parseTitleId('ladder.s5.gold')).toEqual({ source: 'ladder', seasonNo: 5 });
  });

  it('parses slg seasonal ids with season number', () => {
    expect(parseTitleId('slg.s2.warlord')).toEqual({ source: 'slg', seasonNo: 2 });
  });

  it('parses event ids (no season)', () => {
    expect(parseTitleId('event.founder')).toEqual({ source: 'event' });
  });

  it('uses the table source for defined achievement titles', () => {
    expect(parseTitleId('ach.pvp.veteran')).toEqual({ source: 'achievement' });
  });

  it('defaults unknown ids to achievement source', () => {
    expect(parseTitleId('mystery.thing')).toEqual({ source: 'achievement' });
  });
});
