// Unit-style coverage backfill for src/moderation.ts (2026-08-14 test-coverage task). The threshold
// ladder / never-downgrade / optimistic-lock logic here is already exercised end-to-end by
// test/moderation-penalty.e2e.test.ts, but that file imports `applyPenalty`/`buildApp` from
// '../dist/*.js' (compiled output) — vitest's v8 coverage provider only attributes execution to
// src/*.ts when the module was loaded through vitest's own transform, so running the compiled dist
// through Node's loader records zero coverage against src/moderation.ts even though the same logic
// runs. This file imports `applyPenalty`/`actionForScore`/`ModerationConflictError` directly from
// '../src/moderation.js' (backed by FakeCollection — plain findOne/updateOne with dotted $set, no real
// Mongo needed) and re-exercises the same scenarios, plus the one branch the e2e suite never reached:
// REV_RETRIES (8) exhausted under sustained moderationRev conflict → ModerationConflictError thrown.
import { describe, it, expect } from 'vitest';
import type { Collections } from '@nw/shared';
import { applyPenalty, actionForScore, ModerationConflictError, TEMP_BAN_DURATION_MS } from '../src/moderation.js';
import { FakeCollection } from './helpers/fakeCollection.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface AccountDoc {
  _id: string;
  createdAt: number;
  flags?: {
    reputationScore?: number;
    moderationRev?: number;
    banned?: boolean;
    bannedUntil?: number;
    mutedUntil?: number;
    reputationDecayAt?: number;
  };
}

/**
 * FakeCollection's query matcher does strict `===` equality (no real-Mongo "null also matches a missing
 * field" semantics), but applyPenalty's CAS filter is `{'flags.moderationRev': doc.flags?.moderationRev
 * ?? null}` — on a real Mongo document that never had `flags` written yet, that `null` filter clause
 * legitimately matches the missing field. Normalizing every seed to carry an explicit
 * `flags.moderationRev: 0` (which real accounts always do post-first-penalty, and which
 * moderation-penalty.e2e.test.ts's real-Mongo docs get for free from Mongo's null/missing equivalence)
 * sidesteps that FakeCollection gap without touching the shared helper.
 */
function makeCols(seed: AccountDoc[] = []): { cols: Collections; accounts: FakeCollection<AccountDoc> } {
  const accounts = new FakeCollection<AccountDoc>();
  const normalized = seed.map((d) => ({ ...d, flags: { moderationRev: 0, ...d.flags } }));
  if (normalized.length) accounts.seed(...normalized);
  return { cols: { accounts } as unknown as Collections, accounts };
}

describe('actionForScore (§4.2 threshold table)', () => {
  it('maps score ranges to the confirmed action ladder', () => {
    expect(actionForScore(100)).toBe('none');
    expect(actionForScore(81)).toBe('none');
    expect(actionForScore(80)).toBe('warn');
    expect(actionForScore(61)).toBe('warn');
    expect(actionForScore(60)).toBe('mute');
    expect(actionForScore(41)).toBe('mute');
    expect(actionForScore(40)).toBe('tempban');
    expect(actionForScore(21)).toBe('tempban');
    expect(actionForScore(20)).toBe('ban');
    expect(actionForScore(0)).toBe('ban');
  });
});

describe('applyPenalty (src import, coverage backfill)', () => {
  it('a fresh account starts at 100 and a single -20 penalty lands in the warn tier (80)', async () => {
    const { cols, accounts } = makeCols([{ _id: 'acct1', createdAt: 0 }]);
    const result = await applyPenalty(cols, 'acct1', -20, 1000);
    expect(result).toMatchObject({ reputationScore: 80, action: 'warn' });
    expect(result?.mutedUntil).toBeUndefined();
    expect(result?.bannedUntil).toBeUndefined();
    expect(result?.banned).toBeUndefined();

    const doc = await accounts.findOne({ _id: 'acct1' });
    expect(doc?.flags?.reputationScore).toBe(80);
    expect(doc?.flags?.reputationDecayAt).toBe(1000 + 30 * DAY);
    expect(doc?.flags?.moderationRev).toBe(1);
  });

  it('two -20 penalties (100→80→60) triggers a 24h mute on the second', async () => {
    const { cols, accounts } = makeCols([{ _id: 'acct2', createdAt: 0 }]);
    await applyPenalty(cols, 'acct2', -20, 1000);
    const r2 = await applyPenalty(cols, 'acct2', -20, 2000);
    expect(r2).toMatchObject({ reputationScore: 60, action: 'mute' });
    expect(r2?.mutedUntil).toBe(2000 + 24 * HOUR);

    const doc = await accounts.findOne({ _id: 'acct2' });
    expect(doc?.flags?.mutedUntil).toBe(2000 + 24 * HOUR);
  });

  it('three -20 penalties (100→...→40) triggers a 7-day temp ban', async () => {
    const { cols, accounts } = makeCols([{ _id: 'acct3t', createdAt: 0 }]);
    await applyPenalty(cols, 'acct3t', -20, 1000);
    await applyPenalty(cols, 'acct3t', -20, 2000);
    const r3 = await applyPenalty(cols, 'acct3t', -20, 3000);
    expect(r3).toMatchObject({ reputationScore: 40, action: 'tempban' });
    expect(r3?.bannedUntil).toBe(3000 + TEMP_BAN_DURATION_MS);
    const doc = await accounts.findOne({ _id: 'acct3t' });
    expect(doc?.flags?.bannedUntil).toBe(3000 + TEMP_BAN_DURATION_MS);
  });

  it('four -20 penalties (100→...→20) triggers a permanent ban, not just a temp ban', async () => {
    const { cols, accounts } = makeCols([{ _id: 'acct3', createdAt: 0 }]);
    let last;
    for (let i = 0; i < 4; i++) last = await applyPenalty(cols, 'acct3', -20, 1000 + i);
    expect(last).toMatchObject({ reputationScore: 20, action: 'ban', banned: true });

    const doc = await accounts.findOne({ _id: 'acct3' });
    expect(doc?.flags?.banned).toBe(true);
  });

  it('reputationScore is clamped at 0 (cannot go negative)', async () => {
    const { cols } = makeCols([{ _id: 'acct4', createdAt: 0, flags: { reputationScore: 5 } }]);
    const result = await applyPenalty(cols, 'acct4', -20, 1000);
    expect(result?.reputationScore).toBe(0);
  });

  it('a "none"/"warn" tier penalty adds no restriction fields and does not clear an existing harsher one (never $unset)', async () => {
    const { cols, accounts } = makeCols([
      { _id: 'acct-warn', createdAt: 0, flags: { reputationScore: 100, mutedUntil: 999999 } },
    ]);
    const result = await applyPenalty(cols, 'acct-warn', -5, 1000); // 100-5=95 → 'none'
    expect(result?.action).toBe('none');
    expect(result?.mutedUntil).toBeUndefined(); // result object itself carries nothing new
    const doc = await accounts.findOne({ _id: 'acct-warn' });
    expect(doc?.flags?.mutedUntil).toBe(999999); // untouched, not cleared
  });

  it('never downgrades an existing harsher mutedUntil/bannedUntil (a later milder-tier penalty keeps the longer expiry)', async () => {
    const farFuture = 10_000_000_000;
    const { cols, accounts } = makeCols([
      { _id: 'acct5', createdAt: 0, flags: { reputationScore: 55, mutedUntil: farFuture } },
    ]);
    const result = await applyPenalty(cols, 'acct5', -1, 2000);
    expect(result?.action).toBe('mute');
    expect(result?.mutedUntil).toBe(farFuture);
    const doc = await accounts.findOne({ _id: 'acct5' });
    expect(doc?.flags?.mutedUntil).toBe(farFuture);
  });

  it('never downgrades an existing harsher bannedUntil (tempban tier keeps the longer existing expiry)', async () => {
    const farFuture = 10_000_000_000;
    const { cols } = makeCols([
      { _id: 'acct-tb', createdAt: 0, flags: { reputationScore: 39, bannedUntil: farFuture } },
    ]);
    const result = await applyPenalty(cols, 'acct-tb', -1, 2000); // 39-1=38 → still tempban tier
    expect(result?.action).toBe('tempban');
    expect(result?.bannedUntil).toBe(farFuture);
  });

  it('an already-permanently-banned account stays banned regardless of this call\'s own tier', async () => {
    const { cols } = makeCols([
      { _id: 'acct6', createdAt: 0, flags: { reputationScore: 10, banned: true } },
    ]);
    const result = await applyPenalty(cols, 'acct6', 45, 2000); // 10+45=55 → 'mute' tier
    expect(result?.banned).toBe(true);
    expect(result?.action).toBe('mute');
  });

  it('reputationScore reaching exactly 100 does not set reputationDecayAt (only < 100 restarts the clock)', async () => {
    const { cols, accounts } = makeCols([{ _id: 'acct-full', createdAt: 0, flags: { reputationScore: 90 } }]);
    const result = await applyPenalty(cols, 'acct-full', 10, 1000); // 90+10=100
    expect(result?.reputationScore).toBe(100);
    const doc = await accounts.findOne({ _id: 'acct-full' });
    expect(doc?.flags?.reputationDecayAt).toBeUndefined();
  });

  it('returns null for a non-existent account', async () => {
    const { cols } = makeCols();
    const result = await applyPenalty(cols, 'ghost', -20, 1000);
    expect(result).toBeNull();
  });

  it('CONCURRENT: six -20 penalties fired at once all land, none silently lost', async () => {
    const { cols, accounts } = makeCols([{ _id: 'acct-concurrent', createdAt: 0 }]);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => applyPenalty(cols, 'acct-concurrent', -20, 1000)),
    );
    expect(results.every((r) => r !== null)).toBe(true);
    const doc = await accounts.findOne({ _id: 'acct-concurrent' });
    expect(doc?.flags?.reputationScore).toBe(0);
    expect(doc?.flags?.banned).toBe(true);
    expect(doc?.flags?.moderationRev).toBe(6);
  });

  it('REV_RETRIES exhausted (sustained moderationRev conflict) throws ModerationConflictError', async () => {
    const { cols } = makeCols([{ _id: 'acct-conflict', createdAt: 0 }]);
    const accounts = (cols as unknown as { accounts: FakeCollection<AccountDoc> }).accounts;
    // Force every write attempt to report "no document matched" (simulating another writer winning
    // the moderationRev CAS every single time) — this can never happen 8 times in a row in reality,
    // but that's exactly the branch this test exists to force.
    accounts.updateOne = async () => ({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 });
    await expect(applyPenalty(cols, 'acct-conflict', -20, 1000)).rejects.toThrow(ModerationConflictError);
    await expect(applyPenalty(cols, 'acct-conflict', -20, 1000)).rejects.toThrow('moderation write conflict, retry');
  });
});
