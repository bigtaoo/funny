// Coin-anomaly offline daily audit e2e (COMMERCIAL_DESIGN §6.6, 2026-07-26): real Mongo (antiCheatReviews) +
// a fake commercial client seeded with per-day gain results (no real ledger needed here — that aggregation
// is covered by server/commercial/test/audit.e2e.test.ts; this test covers the metaserver-side orchestration:
// dayKey selection, review-record filing, idempotent re-scan, and publicId snapshotting).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type MongoHandle } from '@nw/shared';
import { auditCoinAnomaliesOnce } from '../src/coinAnomalyAudit.js';
import { fakeCommercial } from './helpers/fakeClients.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_coin_anomaly_test';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[coin-anomaly-audit.e2e] Mongo unreachable (${URI}) — skipping.`);

// A fixed "now" one hour into 2026-07-21 UTC — "yesterday" from this now() is always 2026-07-20.
const NOW = Date.parse('2026-07-21T01:00:00.000Z');
const YESTERDAY = '2026-07-20';

describe.skipIf(!mongo)('coin-anomaly offline daily audit e2e', () => {
  const m = mongo!;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('files a coin_anomaly review for each flagged account, scoped to yesterday\'s dayKey', async () => {
    const commercial = fakeCommercial();
    commercial.coinGainsByDay.set(YESTERDAY, [
      { accountId: 'acctA', nonRechargeGain: 5000 },
      { accountId: 'acctB', nonRechargeGain: 3200 },
    ]);
    await m.collections.accounts.insertOne({ _id: 'acctA', createdAt: 0, publicId: 'PUB-A' } as never);

    const result = await auditCoinAnomaliesOnce({ cols: m.collections, commercial, now: () => NOW });
    expect(result).toEqual({ dayKey: YESTERDAY, scanned: 2, flagged: 2 });

    const reviews = await m.collections.antiCheatReviews.find({ kind: 'coin_anomaly' }).sort({ accountId: 1 }).toArray();
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({
      _id: 'coin:acctA:2026-07-20', accountId: 'acctA', publicId: 'PUB-A',
      dayKey: YESTERDAY, nonRechargeGain: 5000, threshold: 3000, status: 'open',
    });
    expect(reviews[1]).toMatchObject({
      _id: 'coin:acctB:2026-07-20', accountId: 'acctB', nonRechargeGain: 3200, status: 'open',
    });
    expect(reviews[1]).not.toHaveProperty('publicId'); // no account doc seeded for acctB → omitted, not null/undefined-key
  });

  it('re-running the same day is idempotent: no duplicate review, already-resolved records are untouched', async () => {
    const commercial = fakeCommercial();
    commercial.coinGainsByDay.set(YESTERDAY, [{ accountId: 'repeat', nonRechargeGain: 9000 }]);

    const first = await auditCoinAnomaliesOnce({ cols: m.collections, commercial, now: () => NOW });
    expect(first.flagged).toBe(1);

    // Ops resolves it as dismissed before the next scan tick.
    await m.collections.antiCheatReviews.updateOne(
      { _id: 'coin:repeat:2026-07-20' },
      { $set: { status: 'reviewed', resolution: 'dismissed', resolvedAt: NOW, resolvedBy: 'ops1' } },
    );

    const second = await auditCoinAnomaliesOnce({ cols: m.collections, commercial, now: () => NOW });
    expect(second).toEqual({ dayKey: YESTERDAY, scanned: 1, flagged: 0 }); // scanned again, but not re-filed

    const rows = await m.collections.antiCheatReviews.find({ _id: 'coin:repeat:2026-07-20' }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'reviewed', resolution: 'dismissed' }); // untouched by the re-scan
  });

  it('commercial unavailable → no-op, never throws', async () => {
    const commercial = fakeCommercial(false);
    const result = await auditCoinAnomaliesOnce({ cols: m.collections, commercial, now: () => NOW });
    expect(result).toEqual({ dayKey: YESTERDAY, scanned: 0, flagged: 0 });
    expect(await m.collections.antiCheatReviews.countDocuments({})).toBe(0);
  });

  it('no accounts over threshold that day → no review records filed', async () => {
    const commercial = fakeCommercial();
    // Nothing seeded for YESTERDAY at all.
    const result = await auditCoinAnomaliesOnce({ cols: m.collections, commercial, now: () => NOW });
    expect(result).toEqual({ dayKey: YESTERDAY, scanned: 0, flagged: 0 });
  });
});
