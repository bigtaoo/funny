// src/logic/ladder.ts — the ladder season countdown.
import { describe, expect, it } from 'vitest';
import { seasonCountdown, WARNING_DAYS } from '../src/logic/ladder';

const DAY = 86400_000;
const NOW = new Date(2026, 7, 20, 12, 0).getTime();

describe('seasonCountdown', () => {
  it('reports whole days remaining', () => {
    expect(seasonCountdown(NOW + 10 * DAY, NOW)).toEqual({ daysLeft: 10, near: false, text: '10 days' });
  });

  it('rounds a partial day UP — some of today still counts', () => {
    expect(seasonCountdown(NOW + 9.2 * DAY, NOW).daysLeft).toBe(10);
  });

  it('uses the singular at one day', () => {
    expect(seasonCountdown(NOW + DAY, NOW).text).toBe('1 day ⚠ ending soon');
  });

  it('flags the last three days as ending soon', () => {
    expect(seasonCountdown(NOW + WARNING_DAYS * DAY, NOW).near).toBe(true);
    expect(seasonCountdown(NOW + (WARNING_DAYS + 1) * DAY, NOW).near).toBe(false);
  });

  it('reads "Expired" rather than a negative count once the end passed', () => {
    expect(seasonCountdown(NOW - 2 * DAY, NOW)).toEqual({ daysLeft: -2, near: true, text: 'Expired' });
  });

  it('keeps the warning colour on an over-running season — that is when someone should look', () => {
    expect(seasonCountdown(NOW - DAY, NOW).near).toBe(true);
  });

  it('treats the exact end instant as expired', () => {
    expect(seasonCountdown(NOW, NOW)).toMatchObject({ daysLeft: 0, text: 'Expired' });
  });
});
