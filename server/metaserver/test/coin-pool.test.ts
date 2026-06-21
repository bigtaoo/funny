// 成就金币池校准守护（S9-8 / A-10，ECONOMY §9）：锁定当前一次性金币总池 + 反通胀护栏。
// 成就是 one-shot faucet（A1 纯一次性、绝不构成持续金币泵）；改条目/调数值即触发此测试提醒，
// 防止无意中把池冲大或塞入「巨额单条 → 准战力发放」。校准结论见 ECONOMY_BALANCE §2.4。
import { describe, it, expect } from 'vitest';
import { ACHIEVEMENTS } from '@nw/shared';

/** 单条满阶金币（领满 3 阶）。 */
function fullPool(coins: number[]): number {
  return coins.reduce((s, c) => s + c, 0);
}

describe('成就金币池校准（A-10）', () => {
  const perAch = ACHIEVEMENTS.map((a) => ({ id: a.id, full: fullPool(a.tiers.map((t) => t.coins)) }));
  const total = perAch.reduce((s, a) => s + a.full, 0);

  it('当前总池锁定 = 2250（5 条 ×3 阶；改条目/数值即提醒同步 ECONOMY §2.4）', () => {
    expect(total).toBe(2250);
  });

  it('单条满阶在 [350,700] 一次性区间内（无巨额单条 → 防准战力发放，A1/A3）', () => {
    for (const a of perAch) {
      expect(a.full).toBeGreaterThanOrEqual(350);
      expect(a.full).toBeLessThanOrEqual(700);
    }
  });

  it('平均单条满阶 ≤ 500（反通胀护栏：摊到 ~25 条仍落在 8–9k 目标带的合理上沿）', () => {
    const avg = total / ACHIEVEMENTS.length;
    expect(avg).toBeLessThanOrEqual(500);
    // 目标带投影：~25 条 × 当前均值 → 一次性总池（设计目标 ~8–9k，ECONOMY §2.4）。
    const projected = avg * 25;
    expect(projected).toBeGreaterThanOrEqual(8000);
    expect(projected).toBeLessThanOrEqual(12000);
  });

  it('每阶金币单调非降 + 阈值单调非降（逐阶领体验，§4.1）', () => {
    for (const a of ACHIEVEMENTS) {
      for (let i = 1; i < a.tiers.length; i++) {
        expect(a.tiers[i].coins).toBeGreaterThanOrEqual(a.tiers[i - 1].coins);
        expect(a.tiers[i].threshold).toBeGreaterThanOrEqual(a.tiers[i - 1].threshold);
      }
    }
  });
});
