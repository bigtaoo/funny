// Unit tests for antiCheatAudit.ts: sample-probability escalation, overclaim comparison, clamped rollback
// (ACHIEVEMENT_DESIGN.md §4.4). Pure functions (rand injected), no DB.
import { describe, it, expect } from 'vitest';
import {
  AUDIT_SAMPLE_P0,
  AUDIT_SAMPLE_P_FLAGGED,
  auditSampleProbability,
  shouldAuditSample,
  compareAudit,
  applyRollback,
} from '../src/antiCheatAudit';
import type { SaveData } from '../src/types';

type Stats = SaveData['stats'];
const stats = (o: Record<string, number>): Stats => o as Stats;

// ── sample probability ────────────────────────────────────────────────────────────

describe('auditSampleProbability', () => {
  it('clean accounts use the base rate', () => {
    expect(auditSampleProbability(0)).toBe(AUDIT_SAMPLE_P0);
  });

  it('previously flagged accounts use the escalated rate', () => {
    expect(auditSampleProbability(1)).toBe(AUDIT_SAMPLE_P_FLAGGED);
  });

  it('escalated rate is higher than base', () => {
    expect(AUDIT_SAMPLE_P_FLAGGED).toBeGreaterThan(AUDIT_SAMPLE_P0);
  });

  it('honors custom probabilities', () => {
    expect(auditSampleProbability(0, { p0: 0.5 })).toBe(0.5);
    expect(auditSampleProbability(2, { pFlagged: 0.9 })).toBe(0.9);
  });
});

describe('shouldAuditSample', () => {
  it('selects when rand is below the probability', () => {
    expect(shouldAuditSample(0, AUDIT_SAMPLE_P0 - 0.001)).toBe(true);
  });

  it('skips when rand is at or above the probability', () => {
    expect(shouldAuditSample(0, AUDIT_SAMPLE_P0)).toBe(false);
  });

  it('a flagged account is sampled at a rand a clean account would skip', () => {
    const r = (AUDIT_SAMPLE_P0 + AUDIT_SAMPLE_P_FLAGGED) / 2;
    expect(shouldAuditSample(0, r)).toBe(false);
    expect(shouldAuditSample(1, r)).toBe(true);
  });
});

// ── compareAudit ──────────────────────────────────────────────────────────────────

describe('compareAudit', () => {
  it('clean when reported equals authoritative', () => {
    const res = compareAudit({ 'kill.archer': 10 }, { 'kill.archer': 10 });
    expect(res.suspicious).toBe(false);
    expect(res.overclaim).toEqual({});
  });

  it('clean when under-reporting (only overclaims are flagged)', () => {
    const res = compareAudit({ 'kill.archer': 5 }, { 'kill.archer': 10 });
    expect(res.suspicious).toBe(false);
  });

  it('flags an overclaim with the exact excess', () => {
    const res = compareAudit({ 'kill.archer': 30 }, { 'kill.archer': 10 });
    expect(res.suspicious).toBe(true);
    expect(res.overclaim).toEqual({ 'kill.archer': 20 });
  });

  it('treats missing authoritative values as 0 (full overclaim)', () => {
    const res = compareAudit({ 'cast.meteor': 4 }, undefined);
    expect(res.overclaim).toEqual({ 'cast.meteor': 4 });
  });

  it('ignores non-audited keys such as pvp.wins', () => {
    const res = compareAudit({ 'pvp.wins': 999 } as never, {});
    expect(res.suspicious).toBe(false);
    expect(res.overclaim).toEqual({});
  });
});

// ── applyRollback ─────────────────────────────────────────────────────────────────

describe('applyRollback', () => {
  it('deducts the overclaim from lifetime stats', () => {
    const { stats: next, rolledBack } = applyRollback(stats({ 'kill.archer': 100 }), { 'kill.archer': 20 });
    expect(next!['kill.archer']).toBe(80);
    expect(rolledBack).toEqual({ 'kill.archer': 20 });
  });

  it('clamps the deduction at zero (never negative)', () => {
    const { stats: next, rolledBack } = applyRollback(stats({ 'kill.archer': 5 }), { 'kill.archer': 20 });
    expect(next!['kill.archer']).toBe(0);
    expect(rolledBack).toEqual({ 'kill.archer': 5 }); // actual deduction < theoretical overclaim
  });

  it('returns prev unchanged (same reference) when there is nothing to deduct', () => {
    const prev = stats({ 'kill.archer': 5 });
    const { stats: next, rolledBack } = applyRollback(prev, {});
    expect(next).toBe(prev);
    expect(rolledBack).toEqual({});
  });

  it('ignores non-positive overclaim entries', () => {
    const prev = stats({ 'kill.archer': 5 });
    const { stats: next } = applyRollback(prev, { 'kill.archer': 0 });
    expect(next).toBe(prev);
  });

  it('does not mutate the input stats', () => {
    const prev = stats({ 'kill.archer': 100 });
    applyRollback(prev, { 'kill.archer': 20 });
    expect(prev['kill.archer']).toBe(100);
  });
});
