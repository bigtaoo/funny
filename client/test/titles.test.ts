// Unit tests for the client-side title mirror (game/meta/titles.ts). Must stay in sync with the
// server authority @nw/shared/src/titles.ts — SLG season titles (slg.s{N}.{key}) were wired up
// alongside worldsvc SLG season settlement (TITLE_DESIGN §3, 2026-07-16).
import { describe, it, expect } from 'vitest';
import {
  titleWeight,
  getTitleKeys,
  formatSlgTitle,
  formatLadderTitle,
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
