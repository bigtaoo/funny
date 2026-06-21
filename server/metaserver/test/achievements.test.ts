// 成就纯逻辑单测（S9-1，无 Mongo 总会跑）：tierState / validateClaim / hasClaimable。
// 数值见 ECONOMY_BALANCE.md §2.4；机制见 ACHIEVEMENT_DESIGN.md §4。
import { describe, it, expect } from 'vitest';
import {
  ACHIEVEMENTS,
  findAchievement,
  tierState,
  hasClaimable,
  validateClaim,
  sanitizePvpReportedStats,
  accrueStats,
  PVP_STAT_MATCH_CAP,
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

describe('sanitizePvpReportedStats（S9-6 L1 异常复查）', () => {
  it('正常上报：保留可上报 key 非零项', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': 3, 'kill.guard': 1, 'cast.meteor': 2 })).toEqual({
      'kill.archer': 3,
      'kill.guard': 1,
      'cast.meteor': 2,
    });
  });

  it('未知 / 不可上报 key 丢弃（不拒整份）：pvp.wins / campaign.* / 乱码', () => {
    expect(
      sanitizePvpReportedStats({ 'kill.archer': 5, 'pvp.wins': 99, 'campaign.chaptersCleared': 9, junk: 1 }),
    ).toEqual({ 'kill.archer': 5 });
  });

  it('0 值省略（懒创建）', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': 0, 'cast.meteor': 4 })).toEqual({ 'cast.meteor': 4 });
  });

  it('缺省 / 空 → 空增量', () => {
    expect(sanitizePvpReportedStats(undefined)).toEqual({});
    expect(sanitizePvpReportedStats({})).toEqual({});
  });

  it('L1 越界 → null（整份拒收）', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': PVP_STAT_MATCH_CAP['kill.archer']! + 1 })).toBeNull();
    expect(sanitizePvpReportedStats({ 'cast.meteor': 99999 })).toBeNull();
  });

  it('恰好等于硬边界 → 接受', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': PVP_STAT_MATCH_CAP['kill.archer']! })).toEqual({
      'kill.archer': PVP_STAT_MATCH_CAP['kill.archer'],
    });
  });

  it('非整数 / 负数 → null', () => {
    expect(sanitizePvpReportedStats({ 'kill.archer': -1 })).toBeNull();
    expect(sanitizePvpReportedStats({ 'cast.meteor': 1.5 })).toBeNull();
    expect(sanitizePvpReportedStats({ 'kill.guard': NaN })).toBeNull();
  });
});

describe('accrueStats（S9-6 服务器累加）', () => {
  it('懒创建：无增量 → 原样返回 prev（含 undefined）', () => {
    expect(accrueStats(undefined, {})).toBeUndefined();
    const prev = { 'kill.archer': 3 };
    expect(accrueStats(prev, {})).toBe(prev); // 同引用，不实例化新对象
  });

  it('缺省 prev + 增量 → 新 stats', () => {
    expect(accrueStats(undefined, { 'pvp.wins': 1, 'kill.archer': 2 })).toEqual({
      'pvp.wins': 1,
      'kill.archer': 2,
    });
  });

  it('已有 prev → 逐 key 累加，不动未涉及 key', () => {
    expect(
      accrueStats({ 'kill.archer': 10, 'pvp.wins': 5 }, { 'kill.archer': 3, 'cast.meteor': 1 }),
    ).toEqual({ 'kill.archer': 13, 'pvp.wins': 5, 'cast.meteor': 1 });
  });

  it('不可变：不改 prev', () => {
    const prev = { 'kill.archer': 10 };
    accrueStats(prev, { 'kill.archer': 5 });
    expect(prev['kill.archer']).toBe(10);
  });
});
