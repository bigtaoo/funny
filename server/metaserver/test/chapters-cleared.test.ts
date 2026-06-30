// Pure function for the `campaign.chaptersCleared` achievement stat (S9-3, ACHIEVEMENT_DESIGN §3.1):
// a chapter = its final level `ch{N}_lv{max}`; chapters cleared = number of final levels present in cleared. Only increments on first clear; replaying does not increment.
import { describe, it, expect } from 'vitest';
import { chaptersClearedCount } from '@nw/shared';

describe('chaptersClearedCount', () => {
  it('empty cleared → 0', () => {
    expect(chaptersClearedCount([])).toBe(0);
  });

  it('non-final levels within a chapter do not count as chapter clear (lv1..lv9 excluded)', () => {
    expect(chaptersClearedCount(['ch1_lv1', 'ch1_lv5', 'ch1_lv9'])).toBe(0);
  });

  it('clearing the final level counts as 1 chapter', () => {
    expect(chaptersClearedCount(['ch1_lv9', 'ch1_lv10'])).toBe(1);
  });

  it('deduped count across multiple chapters (final level of each)', () => {
    expect(chaptersClearedCount(['ch1_lv10', 'ch2_lv10', 'ch3_lv10'])).toBe(3);
  });

  it('final level appearing multiple times still counts as 1 (Set dedup)', () => {
    expect(chaptersClearedCount(['ch1_lv10', 'ch1_lv10'])).toBe(1);
  });

  it('special level ch_stress (no final level number) does not count as a chapter', () => {
    expect(chaptersClearedCount(['ch_stress'])).toBe(0);
    expect(chaptersClearedCount(['ch_stress', 'ch1_lv10'])).toBe(1);
  });

  it('monotonic: adding more final levels only increases the count', () => {
    const a = chaptersClearedCount(['ch1_lv10']);
    const b = chaptersClearedCount(['ch1_lv10', 'ch2_lv10']);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(b).toBe(2);
  });
});
