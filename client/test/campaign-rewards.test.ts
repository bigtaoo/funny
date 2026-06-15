import { describe, it, expect } from 'vitest';
import { computeStars, remainingHpPct } from '../src/game/meta/campaignRewards';

// PVE_INTEGRITY_PLAN §8 起，通关结算（progress/stars/materials）是服务器权威，
// 旧本地 applyCampaignClear 已删除（走 SaveManager.recordClear → POST /pve/clear）。
// 本文件只保留客户端评星纯函数（结果报给服务器校验）。

describe('computeStars', () => {
  it('counts non-decreasing thresholds met', () => {
    expect(computeStars([50, 80, 100], 100)).toBe(3);
    expect(computeStars([50, 80, 100], 85)).toBe(2);
    expect(computeStars([50, 80, 100], 50)).toBe(1);
    expect(computeStars([50, 80, 100], 49)).toBe(0);
  });
  it('falls back to 1★ on clear when no thresholds given', () => {
    expect(computeStars(undefined, 1)).toBe(1);
    expect(computeStars(undefined, 0)).toBe(0);
  });
});

describe('remainingHpPct', () => {
  it('is 100 minus base damage, clamped 0..100', () => {
    expect(remainingHpPct(0)).toBe(100);
    expect(remainingHpPct(30)).toBe(70);
    expect(remainingHpPct(140)).toBe(0);
  });
});
