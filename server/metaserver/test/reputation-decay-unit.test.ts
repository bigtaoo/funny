// Unit-style coverage backfill for src/reputationDecay.ts (2026-08-14 test-coverage task). The healing
// sweep logic is already exercised end-to-end by test/reputation-decay.e2e.test.ts, but that file
// imports `decayReputationOnce`/`applyPenalty` from '../dist/*.js' (compiled output) — vitest's v8
// coverage provider only attributes execution to src/*.ts when the module was loaded through vitest's
// own transform, so running the compiled dist through Node's loader records zero coverage against
// src/reputationDecay.ts even though the same logic runs. This file imports `decayReputationOnce`
// directly from '../src/reputationDecay.js' (backed by FakeCollection — plain findOne/updateOne, no
// real Mongo needed) and re-exercises the same scenarios, plus the branches the e2e suite never
// isolated in a controlled way: REV_RETRIES exhausted (returns false, picked up next tick) and the
// mid-loop re-check discovering a concurrent write already cleared/pushed back the decay clock, plus
// the per-account write-failure catch in the outer sweep loop.
import { describe, it, expect } from 'vitest';
import type { Collections } from '@nw/shared';
import { decayReputationOnce } from '../src/reputationDecay.js';
import { applyPenalty } from '../src/moderation.js';
import { FakeCollection } from './helpers/fakeCollection.js';

const DAY = 24 * 3_600_000;

interface AccountDoc {
  _id: string;
  createdAt: number;
  flags?: {
    reputationScore?: number;
    reputationDecayAt?: number;
    moderationRev?: number;
    banned?: boolean;
    bannedUntil?: number;
    mutedUntil?: number;
  };
}

// See moderation-unit.test.ts's identical helper comment: FakeCollection's strict `===` matcher needs an
// explicit `flags.moderationRev: 0` seeded (not left undefined) for the CAS filter `{'flags.moderationRev':
// doc.flags?.moderationRev ?? null}` to match on the very first write — real Mongo treats a `null` filter
// clause as matching a genuinely missing field, FakeCollection does not.
function makeCols(seed: AccountDoc[] = []): { cols: Collections; accounts: FakeCollection<AccountDoc> } {
  const accounts = new FakeCollection<AccountDoc>();
  const normalized = seed.map((d) => ({ ...d, flags: { moderationRev: 0, ...d.flags } }));
  if (normalized.length) accounts.seed(...normalized);
  return { cols: { accounts } as unknown as Collections, accounts };
}

describe('decayReputationOnce (src import, coverage backfill)', () => {
  it('heals a due account by +10 and pushes reputationDecayAt another 30 days out', async () => {
    const { cols, accounts } = makeCols([{ _id: 'a1', createdAt: 0, flags: { reputationScore: 60, reputationDecayAt: 1000 } }]);
    const result = await decayReputationOnce({ cols, now: () => 2000 });
    expect(result).toEqual({ scanned: 1, healed: 1 });

    const doc = await accounts.findOne({ _id: 'a1' });
    expect(doc?.flags?.reputationScore).toBe(70);
    expect(doc?.flags?.reputationDecayAt).toBe(2000 + 30 * DAY);
  });

  it('caps healing at 100 and clears reputationDecayAt once fully healed (nothing left to scan for)', async () => {
    const { cols, accounts } = makeCols([{ _id: 'a2', createdAt: 0, flags: { reputationScore: 95, reputationDecayAt: 1000 } }]);
    const result = await decayReputationOnce({ cols, now: () => 2000 });
    expect(result).toEqual({ scanned: 1, healed: 1 });

    const doc = await accounts.findOne({ _id: 'a2' });
    expect(doc?.flags?.reputationScore).toBe(100);
    expect(doc?.flags?.reputationDecayAt).toBeUndefined();
  });

  it('leaves an account not yet due (reputationDecayAt in the future) untouched — not even scanned (find filter)', async () => {
    const { cols, accounts } = makeCols([{ _id: 'a3', createdAt: 0, flags: { reputationScore: 60, reputationDecayAt: 5000 } }]);
    const result = await decayReputationOnce({ cols, now: () => 2000 });
    expect(result).toEqual({ scanned: 0, healed: 0 });
    const doc = await accounts.findOne({ _id: 'a3' });
    expect(doc?.flags?.reputationScore).toBe(60);
  });

  it('an account with no reputationDecayAt at all (never penalized) is never scanned', async () => {
    const { cols } = makeCols([{ _id: 'a4', createdAt: 0 }]);
    const result = await decayReputationOnce({ cols, now: () => 2000 });
    expect(result).toEqual({ scanned: 0, healed: 0 });
  });

  it('respects batchLimit — a tick processes at most batchLimit due accounts, the rest wait for the next tick', async () => {
    const seeds: AccountDoc[] = [];
    for (let i = 0; i < 5; i++) seeds.push({ _id: `batch${i}`, createdAt: 0, flags: { reputationScore: 50, reputationDecayAt: 1000 } });
    const { cols, accounts } = makeCols(seeds);
    const result = await decayReputationOnce({ cols, now: () => 2000, batchLimit: 3 });
    expect(result).toEqual({ scanned: 3, healed: 3 });

    const healedCount = await accounts.countDocuments({ 'flags.reputationScore': 60 });
    const stillDueCount = await accounts.countDocuments({ 'flags.reputationScore': 50 });
    expect(healedCount).toBe(3);
    expect(stillDueCount).toBe(2);
  });

  it('default batchLimit (1000) is used when omitted', async () => {
    const { cols } = makeCols([{ _id: 'default-limit', createdAt: 0, flags: { reputationScore: 50, reputationDecayAt: 1000 } }]);
    const result = await decayReputationOnce({ cols, now: () => 2000 });
    expect(result).toEqual({ scanned: 1, healed: 1 });
  });

  it('CONCURRENT (real applyPenalty + decay race, same as reputation-decay.e2e): a decay tick racing a fresh penalty never loses either write', async () => {
    const { cols, accounts } = makeCols([{ _id: 'race1', createdAt: 0, flags: { reputationScore: 70, reputationDecayAt: 1000 } }]);
    const [penalty, decay] = await Promise.all([
      applyPenalty(cols, 'race1', -20, 1000),
      decayReputationOnce({ cols, now: () => 1000 }),
    ]);
    expect(penalty).not.toBeNull();
    const doc = await accounts.findOne({ _id: 'race1' });
    if (decay.healed === 1) {
      expect(doc?.flags?.reputationScore).toBe(60);
      expect(typeof doc?.flags?.reputationDecayAt).toBe('number');
    } else {
      expect(decay.healed).toBe(0);
      expect(doc?.flags?.reputationScore).toBe(50);
    }
  });

  it('mid-loop re-check: a concurrent write clears reputationDecayAt between the sweep\'s find() and decayOneAccount\'s own re-read → treated as no-longer-due, not healed', async () => {
    const { cols, accounts } = makeCols([{ _id: 'raced-clear', createdAt: 0, flags: { reputationScore: 60, reputationDecayAt: 1000 } }]);
    const realFindOne = accounts.findOne.bind(accounts);
    let calls = 0;
    accounts.findOne = async (q: Record<string, unknown>) => {
      calls++;
      // First call is the sweep's own `find()`-driven lookup path is a different method (find, not
      // findOne) — so this findOne interception is decayOneAccount's per-account re-read. Simulate a
      // concurrent write (e.g. an admin unban) that cleared reputationDecayAt just before this re-read.
      if (calls === 1) {
        const real = await realFindOne(q);
        return real ? { ...real, flags: { ...real.flags, reputationDecayAt: undefined } } : real;
      }
      return realFindOne(q);
    };
    const result = await decayReputationOnce({ cols, now: () => 2000 });
    expect(result).toEqual({ scanned: 1, healed: 0 });
    const doc = await accounts.findOne({ _id: 'raced-clear' });
    expect(doc?.flags?.reputationScore).toBe(60); // untouched
  });

  it('mid-loop re-check: a concurrent write pushed reputationDecayAt back into the future → no longer due, not healed', async () => {
    const { cols, accounts } = makeCols([{ _id: 'raced-pushed', createdAt: 0, flags: { reputationScore: 60, reputationDecayAt: 1000 } }]);
    const realFindOne = accounts.findOne.bind(accounts);
    let calls = 0;
    accounts.findOne = async (q: Record<string, unknown>) => {
      calls++;
      if (calls === 1) {
        const real = await realFindOne(q);
        return real ? { ...real, flags: { ...real.flags, reputationDecayAt: 999_999_999 } } : real;
      }
      return realFindOne(q);
    };
    const result = await decayReputationOnce({ cols, now: () => 2000 });
    expect(result).toEqual({ scanned: 1, healed: 0 });
  });

  it('REV_RETRIES exhausted (sustained moderationRev conflict on the decay write) → decayOneAccount returns false, sweep reports healed:0 without throwing', async () => {
    const { cols, accounts } = makeCols([{ _id: 'conflict1', createdAt: 0, flags: { reputationScore: 60, reputationDecayAt: 1000 } }]);
    accounts.updateOne = async () => ({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 });
    const result = await decayReputationOnce({ cols, now: () => 2000 });
    expect(result).toEqual({ scanned: 1, healed: 0 });
  });

  it('per-account exception during decay is caught and logged, does not abort the rest of the sweep', async () => {
    const { cols, accounts } = makeCols([
      { _id: 'bad-acct', createdAt: 0, flags: { reputationScore: 60, reputationDecayAt: 1000 } },
      { _id: 'good-acct', createdAt: 0, flags: { reputationScore: 60, reputationDecayAt: 1000 } },
    ]);
    const realFindOne = accounts.findOne.bind(accounts);
    accounts.findOne = async (q: Record<string, unknown>) => {
      if (q._id === 'bad-acct') throw new Error('injected read failure');
      return realFindOne(q);
    };
    const result = await decayReputationOnce({ cols, now: () => 2000 });
    expect(result.scanned).toBe(2);
    expect(result.healed).toBe(1); // only good-acct healed; bad-acct's failure was swallowed
    const good = await accounts.findOne({ _id: 'good-acct' });
    expect(good?.flags?.reputationScore).toBe(70);
  });

  it('multiple accounts due in the same tick all heal independently', async () => {
    const { cols, accounts } = makeCols([
      { _id: 'multi1', createdAt: 0, flags: { reputationScore: 40, reputationDecayAt: 500 } },
      { _id: 'multi2', createdAt: 0, flags: { reputationScore: 80, reputationDecayAt: 500 } },
    ]);
    const result = await decayReputationOnce({ cols, now: () => 1000 });
    expect(result).toEqual({ scanned: 2, healed: 2 });
    expect((await accounts.findOne({ _id: 'multi1' }))?.flags?.reputationScore).toBe(50);
    expect((await accounts.findOne({ _id: 'multi2' }))?.flags?.reputationScore).toBe(90);
  });
});
