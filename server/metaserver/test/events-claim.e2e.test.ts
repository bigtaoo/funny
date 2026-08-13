// claimEventReward concurrency e2e (B6): real Mongo (events/eventParticipants), fake commercial/socialsvc.
// Regression test for a bug where the maxClaims cap was checked via a stale pre-write read, and the atomic
// points-deduction only guarded on points — never re-checking claim count — so two concurrent claims for a
// maxClaims:1 reward could both succeed. Also covers the fix that switched the coin-grant orderId from a
// random UUID to a deterministic dispatchKey (matching the mail-attachment branch's existing idempotency key).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type MongoHandle, type EventDoc } from '@nw/shared';
import { claimEventReward } from '../src/events.js';
import { fakeCommercial, FakeSocialsvc } from './helpers/fakeClients.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_events_claim_test';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[events-claim.e2e] Mongo unreachable (${URI}) — skipping.`);

const NOW = 1_500_000;

function seedEvent(overrides: Partial<EventDoc> = {}): EventDoc {
  return {
    _id: 'ev1',
    title: 'Concurrency Test Event',
    windowStart: 1_000_000,
    windowEnd: 2_000_000,
    tasks: [],
    rewards: [
      { rewardId: 'capped', cost: 10, kind: 'coins', count: 100, maxClaims: 1 },
      { rewardId: 'repeatable3', cost: 10, kind: 'coins', count: 50, maxClaims: 3 },
    ],
    createdAt: 0,
    ...overrides,
  };
}

describe.skipIf(!mongo)('claimEventReward concurrency', () => {
  const m = mongo!;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  /** Seed a participant with enough points for many claims (points aren't the scarce resource in these tests). */
  async function seedParticipant(accountId: string, points: number): Promise<void> {
    await m.collections.eventParticipants.updateOne(
      { _id: `ev1:${accountId}` },
      { $set: { _id: `ev1:${accountId}`, eventId: 'ev1', accountId, points, taskProgress: [], claimedRewards: [], updatedAt: NOW } },
      { upsert: true },
    );
  }

  it('maxClaims:1 — N concurrent claims of the same reward: exactly one succeeds, exactly one coin grant', async () => {
    await m.collections.events.insertOne(seedEvent());
    await seedParticipant('racer', 1000);
    const commercial = fakeCommercial();
    const socialsvc = new FakeSocialsvc();

    const calls = Array.from({ length: 8 }, () =>
      claimEventReward(m.collections, 'racer', 'ev1', 'capped', NOW, commercial, socialsvc),
    );
    const res = await Promise.all(calls);
    const oks = res.filter((r) => r.ok);
    const limited = res.filter((r) => !r.ok && r.error === 'CLAIM_LIMIT_REACHED');
    expect(oks.length).toBe(1);
    expect(limited.length).toBe(7);

    const doc = await m.collections.eventParticipants.findOne({ _id: 'ev1:racer' });
    expect(doc?.claimedRewards).toEqual(['capped']);
    expect(doc?.points).toBe(1000 - 10); // debited exactly once
    // Exactly one coin grant reached commercial — not eight.
    expect(commercial.grantCalls.length).toBe(1);
    expect(commercial.grantCalls[0]).toMatchObject({ accountId: 'racer', amount: 100 });
  });

  it('maxClaims:3 — concurrent claims are capped at exactly 3, each with a distinct grant orderId', async () => {
    await m.collections.events.insertOne(seedEvent());
    await seedParticipant('racer3', 1000);
    const commercial = fakeCommercial();
    const socialsvc = new FakeSocialsvc();

    const calls = Array.from({ length: 6 }, () =>
      claimEventReward(m.collections, 'racer3', 'ev1', 'repeatable3', NOW, commercial, socialsvc),
    );
    const res = await Promise.all(calls);
    expect(res.filter((r) => r.ok).length).toBe(3);
    expect(res.filter((r) => !r.ok && r.error === 'CLAIM_LIMIT_REACHED').length).toBe(3);

    const doc = await m.collections.eventParticipants.findOne({ _id: 'ev1:racer3' });
    expect(doc?.claimedRewards).toEqual(['repeatable3', 'repeatable3', 'repeatable3']);
    expect(doc?.points).toBe(1000 - 30);
    // Every successful claim reached commercial with its own distinct orderId (no dispatchKey collision
    // between concurrently-successful claims of the same repeatable reward).
    expect(commercial.grantCalls.length).toBe(3);
    expect(new Set(commercial.grantCalls.map((c) => c.orderId)).size).toBe(3);
  });

  it('sequential replay of a maxClaims:1 reward after success is rejected, not double-granted', async () => {
    await m.collections.events.insertOne(seedEvent());
    await seedParticipant('seq', 1000);
    const commercial = fakeCommercial();
    const socialsvc = new FakeSocialsvc();

    const first = await claimEventReward(m.collections, 'seq', 'ev1', 'capped', NOW, commercial, socialsvc);
    expect(first.ok).toBe(true);
    const second = await claimEventReward(m.collections, 'seq', 'ev1', 'capped', NOW, commercial, socialsvc);
    expect(second).toEqual({ ok: false, error: 'CLAIM_LIMIT_REACHED' });
    expect(commercial.grantCalls.length).toBe(1);
  });
});
