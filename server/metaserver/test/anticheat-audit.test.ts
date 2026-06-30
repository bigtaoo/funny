// Achievement anti-cheat L2/L3 pure-logic unit tests (S9-7, no Mongo required, always runs): sampling probability / comparison / rollback.
// Mechanism described in ACHIEVEMENT_DESIGN.md §4.4.
import { describe, it, expect } from 'vitest';
import {
  AUDIT_SAMPLE_P0,
  AUDIT_SAMPLE_P_FLAGGED,
  auditSampleProbability,
  shouldAuditSample,
  compareAudit,
  applyRollback,
} from '@nw/shared';

describe('auditSampleProbability sampling probability (L3 escalation)', () => {
  it('clean account (suspicion=0) → p0', () => {
    expect(auditSampleProbability(0)).toBe(AUDIT_SAMPLE_P0);
  });
  it('flagged account (suspicion>0) → p_flagged', () => {
    expect(auditSampleProbability(1)).toBe(AUDIT_SAMPLE_P_FLAGGED);
    expect(auditSampleProbability(5)).toBe(AUDIT_SAMPLE_P_FLAGGED);
  });
  it('opts override defaults', () => {
    expect(auditSampleProbability(0, { p0: 0.5 })).toBe(0.5);
    expect(auditSampleProbability(2, { pFlagged: 0.9 })).toBe(0.9);
  });
});

describe('shouldAuditSample hit determination', () => {
  it('rand below probability → sampled', () => {
    expect(shouldAuditSample(0, 0.01)).toBe(true); // 0.01 < 0.02
    expect(shouldAuditSample(1, 0.3)).toBe(true); // 0.3 < 0.35
  });
  it('rand above probability → not sampled', () => {
    expect(shouldAuditSample(0, 0.5)).toBe(false);
    expect(shouldAuditSample(1, 0.5)).toBe(false);
  });
  it('boundary rand === probability → not sampled (strict less-than)', () => {
    expect(shouldAuditSample(0, AUDIT_SAMPLE_P0)).toBe(false);
  });
  it('suspicion weighting: same rand, flagged is sampled while clean is not', () => {
    const rand = 0.1; // p0(0.02) < 0.1 < p_flagged(0.35)
    expect(shouldAuditSample(0, rand)).toBe(false);
    expect(shouldAuditSample(1, rand)).toBe(true);
  });
});

describe('compareAudit reported vs recomputed comparison (overclaim only)', () => {
  it('equal → clean', () => {
    const r = compareAudit({ 'kill.archer': 10 }, { 'kill.archer': 10 });
    expect(r.suspicious).toBe(false);
    expect(r.overclaim).toEqual({});
  });
  it('under-report → clean (player only harms themselves, not pursued)', () => {
    const r = compareAudit({ 'kill.archer': 5 }, { 'kill.archer': 10 });
    expect(r.suspicious).toBe(false);
    expect(r.overclaim).toEqual({});
  });
  it('single key overclaimed → suspicious, only that key recorded', () => {
    const r = compareAudit({ 'kill.archer': 50 }, { 'kill.archer': 10 });
    expect(r.suspicious).toBe(true);
    expect(r.overclaim).toEqual({ 'kill.archer': 40 });
  });
  it('mixed over/under-report → only overclaimed keys recorded', () => {
    const r = compareAudit(
      { 'kill.archer': 50, 'kill.guard': 3, 'cast.meteor': 9 },
      { 'kill.archer': 10, 'kill.guard': 8, 'cast.meteor': 2 },
    );
    expect(r.suspicious).toBe(true);
    expect(r.overclaim).toEqual({ 'kill.archer': 40, 'cast.meteor': 7 });
  });
  it('keys not in the reportable set are ignored (pvp.wins/campaign.*)', () => {
    const r = compareAudit(
      { 'pvp.wins': 99, 'campaign.chaptersCleared': 99 } as never,
      {},
    );
    expect(r.suspicious).toBe(false);
    expect(r.overclaim).toEqual({});
  });
  it('both sides empty → clean', () => {
    expect(compareAudit(undefined, undefined).suspicious).toBe(false);
    expect(compareAudit({}, {}).suspicious).toBe(false);
  });
});

describe('applyRollback overclaim rollback (clamped at 0)', () => {
  it('sufficient balance: full deduction', () => {
    const { stats, rolledBack } = applyRollback({ 'kill.archer': 100 }, { 'kill.archer': 40 });
    expect(stats?.['kill.archer']).toBe(60);
    expect(rolledBack).toEqual({ 'kill.archer': 40 });
  });
  it('overclaim > current value: clamped to 0, rolledBack records actual deduction', () => {
    const { stats, rolledBack } = applyRollback({ 'kill.archer': 20 }, { 'kill.archer': 40 });
    expect(stats?.['kill.archer']).toBe(0);
    expect(rolledBack).toEqual({ 'kill.archer': 20 });
  });
  it('missing prev (treated as 0): nothing to deduct, rolledBack empty', () => {
    const { stats, rolledBack } = applyRollback(undefined, { 'kill.archer': 40 });
    expect(rolledBack).toEqual({});
    // no actual deduction → stats not instantiated (lazy creation)
    expect(stats).toBeUndefined();
  });
  it('empty overclaim → returned unchanged', () => {
    const prev = { 'kill.archer': 50 };
    const { stats, rolledBack } = applyRollback(prev, {});
    expect(stats).toBe(prev);
    expect(rolledBack).toEqual({});
  });
  it('multiple keys mixed: only deducts keys with overclaim and available balance', () => {
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
