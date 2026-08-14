// Reputation-decay daily sweep e2e (CONTENT_MODERATION_DESIGN.md CM8/CM8.1): real Mongo, covers healing
// (+10 capped at 100), clearing reputationDecayAt once fully healed, leaving accounts not yet due
// untouched, and the batchLimit bound.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type MongoHandle } from '@nw/shared';
import { decayReputationOnce } from '../dist/reputationDecay.js';
import { applyPenalty } from '../dist/moderation.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_reputation_decay_test';
const DAY = 24 * 3_600_000;

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[reputation-decay.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('reputation-decay daily sweep e2e', () => {
  const m = mongo!;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
  });

  afterAll(async () => { await m.close(); });

  it('heals a due account by +10 and pushes reputationDecayAt another 30 days out', async () => {
    await m.collections.accounts.insertOne({
      _id: 'a1', createdAt: 0, flags: { reputationScore: 60, reputationDecayAt: 1000 },
    } as never);
    const result = await decayReputationOnce({ cols: m.collections, now: () => 2000 });
    expect(result).toEqual({ scanned: 1, healed: 1 });

    const doc = await m.collections.accounts.findOne({ _id: 'a1' });
    expect(doc?.flags?.reputationScore).toBe(70);
    expect(doc?.flags?.reputationDecayAt).toBe(2000 + 30 * DAY);
  });

  it('caps healing at 100 and clears reputationDecayAt once fully healed (nothing left to scan for)', async () => {
    await m.collections.accounts.insertOne({
      _id: 'a2', createdAt: 0, flags: { reputationScore: 95, reputationDecayAt: 1000 },
    } as never);
    const result = await decayReputationOnce({ cols: m.collections, now: () => 2000 });
    expect(result).toEqual({ scanned: 1, healed: 1 });

    const doc = await m.collections.accounts.findOne({ _id: 'a2' });
    expect(doc?.flags?.reputationScore).toBe(100);
    expect(doc?.flags?.reputationDecayAt).toBeUndefined();
  });

  it('leaves an account not yet due (reputationDecayAt in the future) untouched', async () => {
    await m.collections.accounts.insertOne({
      _id: 'a3', createdAt: 0, flags: { reputationScore: 60, reputationDecayAt: 5000 },
    } as never);
    const result = await decayReputationOnce({ cols: m.collections, now: () => 2000 });
    expect(result).toEqual({ scanned: 0, healed: 0 });

    const doc = await m.collections.accounts.findOne({ _id: 'a3' });
    expect(doc?.flags?.reputationScore).toBe(60); // unchanged
  });

  it('an account with no reputationDecayAt at all (never penalized) is never scanned', async () => {
    await m.collections.accounts.insertOne({ _id: 'a4', createdAt: 0 } as never);
    const result = await decayReputationOnce({ cols: m.collections, now: () => 2000 });
    expect(result).toEqual({ scanned: 0, healed: 0 });
  });

  it('respects batchLimit — a tick processes at most batchLimit due accounts, the rest wait for the next tick', async () => {
    for (let i = 0; i < 5; i++) {
      await m.collections.accounts.insertOne({
        _id: `batch${i}`, createdAt: 0, flags: { reputationScore: 50, reputationDecayAt: 1000 },
      } as never);
    }
    const result = await decayReputationOnce({ cols: m.collections, now: () => 2000, batchLimit: 3 });
    expect(result).toEqual({ scanned: 3, healed: 3 });

    const healedCount = await m.collections.accounts.countDocuments({ 'flags.reputationScore': 60 });
    const stillDueCount = await m.collections.accounts.countDocuments({ 'flags.reputationScore': 50 });
    expect(healedCount).toBe(3);
    expect(stillDueCount).toBe(2); // left for the next tick, not dropped
  });

  it('CONCURRENT: a decay tick racing a fresh penalty on the same account never loses either write (audit-followup-fixes-0730)', async () => {
    await m.collections.accounts.insertOne({
      _id: 'race1', createdAt: 0, flags: { reputationScore: 70, reputationDecayAt: 1000 },
    } as never);

    // Two legitimate, unrelated writers hit the same account at once: the daily decay sweep (this account
    // is due) and a fresh -20 penalty (a report just got upheld). Without the moderationRev CAS guard, the
    // read-modify-write in one silently overwrites the other's result: e.g. decay's `$set reputationScore:80`
    // landing after the penalty's read but the penalty's `$set reputationScore:50` still commits last would
    // strand the account at 50 with reputationDecayAt wrongly left unset (or vice versa, at 80 with the
    // penalty's mutedUntil/bannedUntil silently dropped). Every valid interleaving is a CAS retry chain, so
    // moderationRev must equal the number of writes that actually happened (2, since decay's own
    // "still due?" recheck only ever skips — it never corrupts).
    const [penalty, decay] = await Promise.all([
      applyPenalty(m.collections, 'race1', -20, 1000),
      decayReputationOnce({ cols: m.collections, now: () => 1000 }),
    ]);
    expect(penalty).not.toBeNull();

    const doc = await m.collections.accounts.findOne({ _id: 'race1' });
    if (decay.healed === 1) {
      // Decay's read won the race (saw 70, healed to 80) and committed before the penalty's read — the
      // penalty then computed off 80: 80-20=60 ('mute' tier), and reset the decay clock (score<100).
      expect(doc?.flags?.reputationScore).toBe(60);
      expect(doc?.flags?.moderationRev).toBe(2);
      expect(typeof doc?.flags?.reputationDecayAt).toBe('number');
    } else {
      // The penalty's write (70-20=50) landed first; by the time decay's internal re-check ran, the account
      // was no longer due (moderationRev/reputationDecayAt had just been reset by the penalty) — decay
      // correctly no-ops instead of clobbering the fresher penalty result.
      expect(decay.healed).toBe(0);
      expect(doc?.flags?.reputationScore).toBe(50);
      expect(doc?.flags?.moderationRev).toBe(1);
    }
  });
});
