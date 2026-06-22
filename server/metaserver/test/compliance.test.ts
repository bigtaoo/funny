// C5 合规接口单测：C5-a 概率公示（权重和=1）+ C5-b 账号删除（auth 410）+
//                 C5-c GDPR 同意（无同意不记录）。
import { describe, it, expect } from 'vitest';

// ── C5-a：概率公示 ─────────────────────────────────────────────────────────
// poolEntries 各条目权重已知，概率 = weight / totalWeight。

function computeProbabilities(entries: { weight: number }[]): number[] {
  const total = entries.reduce((s, e) => s + e.weight, 0);
  return entries.map((e) => (total > 0 ? e.weight / total : 0));
}

describe('C5-a gacha probability', () => {
  it('probabilities sum to 1', () => {
    const entries = [
      { weight: 600 },
      { weight: 300 },
      { weight: 100 },
    ];
    const probs = computeProbabilities(entries);
    const sum = probs.reduce((s, p) => s + p, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('each entry probability is weight/total', () => {
    const entries = [{ weight: 700 }, { weight: 200 }, { weight: 100 }];
    const probs = computeProbabilities(entries);
    expect(probs[0]).toBeCloseTo(0.7, 9);
    expect(probs[1]).toBeCloseTo(0.2, 9);
    expect(probs[2]).toBeCloseTo(0.1, 9);
  });

  it('returns 0 for empty weight pool', () => {
    const probs = computeProbabilities([{ weight: 0 }, { weight: 0 }]);
    expect(probs).toEqual([0, 0]);
  });
});

// ── C5-c：GDPR 同意逻辑 ───────────────────────────────────────────────────

/**
 * Simulates the consent gate in analyticsvc/httpApi.ts:
 * - identified user (userId defined) → only record if consent===true
 * - anonymous (no userId) → always record
 */
function shouldIngest(userId: string | undefined, consent: boolean | undefined): boolean {
  if (userId && !consent) return false;
  return true;
}

describe('C5-c GDPR consent gate', () => {
  it('identified user with consent=true → ingest', () => {
    expect(shouldIngest('acc-1', true)).toBe(true);
  });

  it('identified user without consent → skip', () => {
    expect(shouldIngest('acc-1', undefined)).toBe(false);
    expect(shouldIngest('acc-1', false)).toBe(false);
  });

  it('anonymous user without consent → ingest (no PII)', () => {
    expect(shouldIngest(undefined, undefined)).toBe(true);
    expect(shouldIngest(undefined, false)).toBe(true);
  });

  it('anonymous user with consent=true → ingest', () => {
    expect(shouldIngest(undefined, true)).toBe(true);
  });
});

// ── C5-b：软删除标记逻辑 ──────────────────────────────────────────────────

/**
 * Simulates the rejectIfBanned check in service.ts:
 * deletedAt > 0 → 'deleted', flags.banned → 'banned', else 'ok'
 */
function authCheck(
  doc: { deletedAt?: number; flags?: { banned?: boolean } } | null,
): 'deleted' | 'banned' | 'ok' {
  if (doc?.deletedAt) return 'deleted';
  if (doc?.flags?.banned) return 'banned';
  return 'ok';
}

describe('C5-b account soft delete auth check', () => {
  it('deleted account → rejected', () => {
    expect(authCheck({ deletedAt: 1_700_000_000_000 })).toBe('deleted');
  });

  it('banned account (no deletedAt) → banned', () => {
    expect(authCheck({ flags: { banned: true } })).toBe('banned');
  });

  it('deleted takes precedence over banned', () => {
    expect(authCheck({ deletedAt: 1, flags: { banned: true } })).toBe('deleted');
  });

  it('normal account → ok', () => {
    expect(authCheck({})).toBe('ok');
    expect(authCheck(null)).toBe('ok');
  });
});
