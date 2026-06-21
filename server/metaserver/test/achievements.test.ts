// 成就纯逻辑单测（S9-1，无 Mongo 总会跑）：tierState / validateClaim / hasClaimable。
// 数值见 ECONOMY_BALANCE.md §2.4；机制见 ACHIEVEMENT_DESIGN.md §4。
import { describe, it, expect } from 'vitest';
import {
  ACHIEVEMENTS,
  findAchievement,
  tierState,
  hasClaimable,
  validateClaim,
} from '@nw/shared';

describe('成就定义表', () => {
  it('5 条初值，阶严格递增且阈值非降', () => {
    expect(ACHIEVEMENTS.length).toBe(5);
    for (const a of ACHIEVEMENTS) {
      expect(a.tiers.length).toBe(3);
      for (let i = 1; i < a.tiers.length; i++) {
        expect(a.tiers[i].threshold).toBeGreaterThanOrEqual(a.tiers[i - 1].threshold);
      }
    }
  });
});

describe('tierState 当前阶推导', () => {
  const def = findAchievement('ach.kill.archer')!; // 阈值 100/500/2000，金币 50/100/200

  it('未达任何阶：全 reached=false', () => {
    const st = tierState(def, { 'kill.archer': 50 }, []);
    expect(st.map((s) => s.reached)).toEqual([false, false, false]);
    expect(st[0].progress).toBe(50);
  });

  it('达阶 I/II 未领：claimable，阶 III 未达', () => {
    const st = tierState(def, { 'kill.archer': 600 }, []);
    expect(st[0].claimable).toBe(true);
    expect(st[1].claimable).toBe(true);
    expect(st[2].reached).toBe(false);
    expect(st[0].progress).toBe(100); // 封顶到阈值
  });

  it('已领阶 I：reached 但不 claimable', () => {
    const st = tierState(def, { 'kill.archer': 600 }, [1]);
    expect(st[0].claimed).toBe(true);
    expect(st[0].claimable).toBe(false);
    expect(st[1].claimable).toBe(true);
  });

  it('缺省 stats 视为 0', () => {
    const st = tierState(def, undefined, []);
    expect(st.every((s) => !s.reached)).toBe(true);
  });
});

describe('hasClaimable 红点聚合', () => {
  it('无 stats → 无红点', () => {
    expect(hasClaimable(undefined, undefined)).toBe(false);
  });
  it('某成就达阶未领 → 有红点', () => {
    expect(hasClaimable({ 'kill.archer': 100 }, {})).toBe(true);
  });
  it('达阶且全领 → 无红点', () => {
    expect(
      hasClaimable({ 'kill.archer': 100 }, { 'ach.kill.archer': { claimedTiers: [1] } }),
    ).toBe(false);
  });
});

describe('validateClaim 领取校验（不信客户端）', () => {
  it('未知成就 / 越界阶 → BAD_REQUEST', () => {
    expect(validateClaim('nope', 1, {}, [])).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(validateClaim('ach.kill.archer', 4, { 'kill.archer': 9999 }, [])).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
    expect(validateClaim('ach.kill.archer', 0, {}, [])).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
  });

  it('未达阈值 → NOT_REACHED', () => {
    expect(validateClaim('ach.kill.archer', 2, { 'kill.archer': 100 }, [])).toEqual({
      ok: false,
      error: 'NOT_REACHED',
    });
  });

  it('已领 → ALREADY_CLAIMED', () => {
    expect(validateClaim('ach.kill.archer', 1, { 'kill.archer': 100 }, [1])).toEqual({
      ok: false,
      error: 'ALREADY_CLAIMED',
    });
  });

  it('达阈值且未领 → ok + 该阶金币', () => {
    expect(validateClaim('ach.kill.archer', 1, { 'kill.archer': 100 }, [])).toEqual({
      ok: true,
      coins: 50,
      tier: 1,
    });
    expect(validateClaim('ach.kill.archer', 3, { 'kill.archer': 2000 }, [1, 2])).toEqual({
      ok: true,
      coins: 200,
      tier: 3,
    });
  });
});
