// Unit tests for rechargeMilestone.ts: tier table invariants, claim validation (GACHA_DESIGN §13, ADR-045).
// Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  RECHARGE_TIERS,
  findRechargeTier,
  makeFreshRechargeMilestone,
  claimRechargeReward,
  type RechargeMilestoneData,
} from '../src/rechargeMilestone';

function data(overrides: Partial<RechargeMilestoneData> = {}): RechargeMilestoneData {
  return { ...makeFreshRechargeMilestone(), ...overrides };
}

// ── RECHARGE_TIERS table invariants ────────────────────────────────────────────────

describe('RECHARGE_TIERS', () => {
  it('ids are 1..N in order, matching array index', () => {
    RECHARGE_TIERS.forEach((t, i) => expect(t.id).toBe(i + 1));
  });

  it('thresholdCents is strictly increasing', () => {
    for (let i = 1; i < RECHARGE_TIERS.length; i++) {
      expect(RECHARGE_TIERS[i]!.thresholdCents).toBeGreaterThan(RECHARGE_TIERS[i - 1]!.thresholdCents);
    }
  });

  it('every tier grants at least one reward with a positive count', () => {
    for (const t of RECHARGE_TIERS) {
      expect(t.rewards.length).toBeGreaterThan(0);
      for (const r of t.rewards) expect(r.count).toBeGreaterThan(0);
    }
  });

  it('every tier grants exactly one coins reward', () => {
    for (const t of RECHARGE_TIERS) {
      expect(t.rewards.filter((r) => r.kind === 'coins')).toHaveLength(1);
    }
  });

  it('material rewards carry an id', () => {
    for (const t of RECHARGE_TIERS) {
      for (const r of t.rewards) if (r.kind === 'material') expect(r.id).toBeTruthy();
    }
  });

  it('coin reward escalates with tier', () => {
    const coinCounts = RECHARGE_TIERS.map((t) => t.rewards.find((r) => r.kind === 'coins')!.count);
    for (let i = 1; i < coinCounts.length; i++) expect(coinCounts[i]!).toBeGreaterThan(coinCounts[i - 1]!);
  });
});

// ── findRechargeTier ────────────────────────────────────────────────────────────────

describe('findRechargeTier', () => {
  it('finds an existing tier by id', () => {
    expect(findRechargeTier(1)).toBe(RECHARGE_TIERS[0]);
  });

  it('returns undefined for an unknown id', () => {
    expect(findRechargeTier(0)).toBeUndefined();
    expect(findRechargeTier(RECHARGE_TIERS.length + 1)).toBeUndefined();
  });
});

// ── makeFreshRechargeMilestone ────────────────────────────────────────────────────────

describe('makeFreshRechargeMilestone', () => {
  it('starts with no claimed tiers', () => {
    expect(makeFreshRechargeMilestone()).toEqual({ claimed: [] });
  });
});

// ── claimRechargeReward ──────────────────────────────────────────────────────────────

describe('claimRechargeReward', () => {
  it('rejects an unknown tier id', () => {
    expect(claimRechargeReward(data(), 999999, 0)).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(claimRechargeReward(data(), 999999, RECHARGE_TIERS.length + 1)).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
  });

  it('rejects a tier whose threshold has not been reached', () => {
    const tier1 = RECHARGE_TIERS[0]!;
    const res = claimRechargeReward(data(), tier1.thresholdCents - 1, tier1.id);
    expect(res).toEqual({ ok: false, error: 'NOT_REACHED' });
  });

  it('claims a reached tier and records it', () => {
    const tier1 = RECHARGE_TIERS[0]!;
    const res = claimRechargeReward(data(), tier1.thresholdCents, tier1.id);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rewards).toEqual(tier1.rewards);
      expect(res.data.claimed).toEqual([tier1.id]);
    }
  });

  it('a higher cumulative amount than the threshold still claims fine', () => {
    const tier1 = RECHARGE_TIERS[0]!;
    const res = claimRechargeReward(data(), tier1.thresholdCents + 1_000_000, tier1.id);
    expect(res.ok).toBe(true);
  });

  it('does not mutate the input data', () => {
    const tier1 = RECHARGE_TIERS[0]!;
    const original = data();
    claimRechargeReward(original, tier1.thresholdCents, tier1.id);
    expect(original.claimed).toEqual([]);
  });

  it('rejects double-claiming the same tier', () => {
    const tier1 = RECHARGE_TIERS[0]!;
    const res = claimRechargeReward(data({ claimed: [tier1.id] }), tier1.thresholdCents, tier1.id);
    expect(res).toEqual({ ok: false, error: 'ALREADY_CLAIMED' });
  });

  it('claiming one tier does not affect another tier’s claim state', () => {
    const [tier1, tier2] = RECHARGE_TIERS;
    const afterTier1 = claimRechargeReward(data(), tier1!.thresholdCents, tier1!.id);
    expect(afterTier1.ok).toBe(true);
    if (!afterTier1.ok) return;
    const afterTier2 = claimRechargeReward(afterTier1.data, tier2!.thresholdCents, tier2!.id);
    expect(afterTier2.ok).toBe(true);
    if (afterTier2.ok) expect(afterTier2.data.claimed).toEqual([tier1!.id, tier2!.id]);
  });

  it('a refund that drops cumulative spend below a threshold blocks a not-yet-claimed tier', () => {
    const tier2 = RECHARGE_TIERS[1]!;
    // Simulates a post-refund totalRechargeCents lower than tier2's threshold.
    const res = claimRechargeReward(data(), tier2.thresholdCents - 1, tier2.id);
    expect(res).toEqual({ ok: false, error: 'NOT_REACHED' });
  });
});
