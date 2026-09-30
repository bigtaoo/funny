// Ten-year transaction-record retention (transactionRetention.ts) against a real Mongo: the calendar-year
// cutoff (never a rolling now − 10y), which collections it sweeps, and the subscription-link guard that keeps
// routing an old but still-renewing Apple subscription.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { sweepExpiredTransactionsOnce, transactionRetentionCutoff } from '../src/transactionRetention';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_tx_retention_test';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[commercial.transactionRetention.e2e] Mongo unreachable (${URI}) — skipping.`);

const NOW = Date.parse('2026-09-29T12:00:00Z');
const OLD = Date.parse('2015-12-31T23:59:59Z'); // last instant of 2015 → due in 2026
const KEPT = Date.parse('2016-01-01T00:00:00Z'); // first instant of 2016 → kept until the end of 2026

describe('transactionRetentionCutoff', () => {
  it('is the UTC start of the calendar year ten years back, not a rolling now − 10y', () => {
    expect(transactionRetentionCutoff(NOW)).toBe(KEPT);
    // Same answer on the last day of the year — the cutoff only moves on 1 January.
    expect(transactionRetentionCutoff(Date.parse('2026-12-31T23:59:59Z'))).toBe(KEPT);
    expect(transactionRetentionCutoff(Date.parse('2027-01-01T00:00:00Z'))).toBe(Date.parse('2017-01-01T00:00:00Z'));
  });
});

describe.skipIf(!mongo)('sweepExpiredTransactionsOnce', () => {
  const m = mongo!;
  const c = m.collections;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('deletes payment records from before the cutoff year and keeps everything from it onwards', async () => {
    for (const [id, ts] of [['old', OLD], ['kept', KEPT]] as const) {
      await c.ledger.insertOne({ _id: `l-${id}`, accountId: 'a', ts } as never);
      await c.orders.insertOne({ _id: `o-${id}`, accountId: 'a', ts } as never);
      await c.recharges.insertOne({ _id: `r-${id}`, accountId: 'a', ts } as never);
      await c.paddleEvents.insertOne({ _id: `p-${id}`, accountId: 'a', ts } as never);
      await c.appleNotifications.insertOne({ _id: `n-${id}`, originalTransactionId: `x-${id}`, ts } as never);
    }
    const r = await sweepExpiredTransactionsOnce({ cols: c, now: () => NOW });
    expect(r.cutoff).toBe(KEPT);
    expect(r.removed).toEqual({ ledger: 1, orders: 1, recharges: 1, paddleEvents: 1, appleNotifications: 1, appleTransactionLinks: 0 });
    expect(await c.ledger.distinct('_id')).toEqual(['l-kept']);
    expect(await c.orders.distinct('_id')).toEqual(['o-kept']);
    expect(await c.recharges.distinct('_id')).toEqual(['r-kept']);
    expect(await c.paddleEvents.distinct('_id')).toEqual(['p-kept']);
    expect(await c.appleNotifications.distinct('_id')).toEqual(['n-kept']);

    // Idempotent.
    const again = await sweepExpiredTransactionsOnce({ cols: c, now: () => NOW });
    expect(Object.values(again.removed).every((n) => n === 0)).toBe(true);
  });

  it('drops a stale subscription link, but keeps one Apple still notifies about', async () => {
    await c.appleTransactionLinks.insertMany([
      { _id: 'dead', accountId: 'a', product: 'p', linkedAt: OLD, updatedAt: OLD },
      { _id: 'renewing', accountId: 'b', product: 'p', linkedAt: OLD, updatedAt: OLD },
      { _id: 'fresh', accountId: 'c', product: 'p', linkedAt: KEPT, updatedAt: KEPT },
    ] as never);
    await c.appleNotifications.insertOne({ _id: 'n-renew', originalTransactionId: 'renewing', ts: NOW - 86_400_000 } as never);

    const r = await sweepExpiredTransactionsOnce({ cols: c, now: () => NOW });
    expect(r.removed.appleTransactionLinks).toBe(1);
    expect((await c.appleTransactionLinks.distinct('_id')).sort()).toEqual(['fresh', 'renewing']);
  });
});
