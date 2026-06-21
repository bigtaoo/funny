// 成就 stat `campaign.chaptersCleared` 计数纯函数（S9-3，ACHIEVEMENT_DESIGN §3.1）：
// 章节 = 终关 `ch{N}_lv{max}`，已通关章节数 = cleared 中含的终关个数。首通才涨、重打不涨。
import { describe, it, expect } from 'vitest';
import { chaptersClearedCount } from '@nw/shared';

describe('chaptersClearedCount', () => {
  it('空 cleared → 0', () => {
    expect(chaptersClearedCount([])).toBe(0);
  });

  it('章内非终关不算章节通关（lv1..lv9 不计）', () => {
    expect(chaptersClearedCount(['ch1_lv1', 'ch1_lv5', 'ch1_lv9'])).toBe(0);
  });

  it('终关通关才计 1 章', () => {
    expect(chaptersClearedCount(['ch1_lv9', 'ch1_lv10'])).toBe(1);
  });

  it('多章去重计数（各章终关）', () => {
    expect(chaptersClearedCount(['ch1_lv10', 'ch2_lv10', 'ch3_lv10'])).toBe(3);
  });

  it('终关重复出现仍只计 1（Set 去重）', () => {
    expect(chaptersClearedCount(['ch1_lv10', 'ch1_lv10'])).toBe(1);
  });

  it('特殊关 ch_stress（无终关编号）不计章节', () => {
    expect(chaptersClearedCount(['ch_stress'])).toBe(0);
    expect(chaptersClearedCount(['ch_stress', 'ch1_lv10'])).toBe(1);
  });

  it('单调：追加更多终关只增不减', () => {
    const a = chaptersClearedCount(['ch1_lv10']);
    const b = chaptersClearedCount(['ch1_lv10', 'ch2_lv10']);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(b).toBe(2);
  });
});
