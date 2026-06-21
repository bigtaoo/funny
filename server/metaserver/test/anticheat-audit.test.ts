// 成就反作弊 L2/L3 纯逻辑单测（S9-7，无 Mongo 总会跑）：抽样概率 / 比对 / 回滚。
// 机制见 ACHIEVEMENT_DESIGN.md §4.4。
import { describe, it, expect } from 'vitest';
import {
  AUDIT_SAMPLE_P0,
  AUDIT_SAMPLE_P_FLAGGED,
  auditSampleProbability,
  shouldAuditSample,
  compareAudit,
  applyRollback,
} from '@nw/shared';

describe('auditSampleProbability 抽查概率（L3 升档）', () => {
  it('clean 账号（suspicion=0）→ p0', () => {
    expect(auditSampleProbability(0)).toBe(AUDIT_SAMPLE_P0);
  });
  it('flagged 账号（suspicion>0）→ p_flagged', () => {
    expect(auditSampleProbability(1)).toBe(AUDIT_SAMPLE_P_FLAGGED);
    expect(auditSampleProbability(5)).toBe(AUDIT_SAMPLE_P_FLAGGED);
  });
  it('opts 覆盖默认值', () => {
    expect(auditSampleProbability(0, { p0: 0.5 })).toBe(0.5);
    expect(auditSampleProbability(2, { pFlagged: 0.9 })).toBe(0.9);
  });
});

describe('shouldAuditSample 抽中判定', () => {
  it('rand 低于概率 → 抽中', () => {
    expect(shouldAuditSample(0, 0.01)).toBe(true); // 0.01 < 0.02
    expect(shouldAuditSample(1, 0.3)).toBe(true); // 0.3 < 0.35
  });
  it('rand 高于概率 → 不抽', () => {
    expect(shouldAuditSample(0, 0.5)).toBe(false);
    expect(shouldAuditSample(1, 0.5)).toBe(false);
  });
  it('边界 rand === 概率 → 不抽（严格小于）', () => {
    expect(shouldAuditSample(0, AUDIT_SAMPLE_P0)).toBe(false);
  });
  it('suspicion 加权：同 rand 下 flagged 抽中而 clean 不抽', () => {
    const rand = 0.1; // p0(0.02) < 0.1 < p_flagged(0.35)
    expect(shouldAuditSample(0, rand)).toBe(false);
    expect(shouldAuditSample(1, rand)).toBe(true);
  });
});

describe('compareAudit 上报 vs 复算比对（只看超报）', () => {
  it('相等 → clean', () => {
    const r = compareAudit({ 'kill.archer': 10 }, { 'kill.archer': 10 });
    expect(r.suspicious).toBe(false);
    expect(r.overclaim).toEqual({});
  });
  it('少报 → clean（玩家只亏自己，不追溯）', () => {
    const r = compareAudit({ 'kill.archer': 5 }, { 'kill.archer': 10 });
    expect(r.suspicious).toBe(false);
    expect(r.overclaim).toEqual({});
  });
  it('单键超报 → suspicious，只记该键', () => {
    const r = compareAudit({ 'kill.archer': 50 }, { 'kill.archer': 10 });
    expect(r.suspicious).toBe(true);
    expect(r.overclaim).toEqual({ 'kill.archer': 40 });
  });
  it('混合超/少报 → 只记超报键', () => {
    const r = compareAudit(
      { 'kill.archer': 50, 'kill.guard': 3, 'cast.meteor': 9 },
      { 'kill.archer': 10, 'kill.guard': 8, 'cast.meteor': 2 },
    );
    expect(r.suspicious).toBe(true);
    expect(r.overclaim).toEqual({ 'kill.archer': 40, 'cast.meteor': 7 });
  });
  it('未在可上报集合的键被忽略（pvp.wins/campaign.*）', () => {
    const r = compareAudit(
      { 'pvp.wins': 99, 'campaign.chaptersCleared': 99 } as never,
      {},
    );
    expect(r.suspicious).toBe(false);
    expect(r.overclaim).toEqual({});
  });
  it('双方空 → clean', () => {
    expect(compareAudit(undefined, undefined).suspicious).toBe(false);
    expect(compareAudit({}, {}).suspicious).toBe(false);
  });
});

describe('applyRollback 超报回滚（0 下限钳制）', () => {
  it('库存充足：足额扣回', () => {
    const { stats, rolledBack } = applyRollback({ 'kill.archer': 100 }, { 'kill.archer': 40 });
    expect(stats?.['kill.archer']).toBe(60);
    expect(rolledBack).toEqual({ 'kill.archer': 40 });
  });
  it('超报 > 当前值：钳制到 0，rolledBack 记实际扣减', () => {
    const { stats, rolledBack } = applyRollback({ 'kill.archer': 20 }, { 'kill.archer': 40 });
    expect(stats?.['kill.archer']).toBe(0);
    expect(rolledBack).toEqual({ 'kill.archer': 20 });
  });
  it('缺 prev（视为 0）：无可扣，rolledBack 空', () => {
    const { stats, rolledBack } = applyRollback(undefined, { 'kill.archer': 40 });
    expect(rolledBack).toEqual({});
    // 无实际扣减 → 不实例化 stats（懒创建）
    expect(stats).toBeUndefined();
  });
  it('空 overclaim → 原样返回', () => {
    const prev = { 'kill.archer': 50 };
    const { stats, rolledBack } = applyRollback(prev, {});
    expect(stats).toBe(prev);
    expect(rolledBack).toEqual({});
  });
  it('多键混合：仅扣有超报且有库存的键', () => {
    const { stats, rolledBack } = applyRollback(
      { 'kill.archer': 100, 'kill.guard': 5, 'cast.meteor': 0 },
      { 'kill.archer': 30, 'kill.guard': 10, 'cast.meteor': 4 },
    );
    expect(stats?.['kill.archer']).toBe(70);
    expect(stats?.['kill.guard']).toBe(0);
    expect(stats?.['cast.meteor']).toBe(0);
    expect(rolledBack).toEqual({ 'kill.archer': 30, 'kill.guard': 5 });
  });
});
