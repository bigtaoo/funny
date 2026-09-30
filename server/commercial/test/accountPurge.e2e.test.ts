// Account-deletion purge (POST /internal/accounts/:accountId/purge) end-to-end against a real Mongo.
//
// Pins the retention split service/accountPurge.ts documents: non-payment per-account state is deleted,
// payment records survive (receipt dedupe and refunds must keep working) but lose their raw provider
// payloads, and nothing belonging to another account is touched. Plus the two properties the metaserver
// job relies on: a re-run is harmless, and the route is closed without X-Internal-Key.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createInternalAuth } from '@nw/shared';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';
import { startInternalHttp } from '../src/internalHttp';
import { jsonBody } from './jsonBody';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_account_purge_test';
const KEY = 'test-internal-key';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[commercial.accountPurge.e2e] Mongo unreachable (${URI}) — skipping.`);

let t = 1_000_000;
const now = () => t++;

describe.skipIf(!mongo)('commercial account purge', () => {
  const m = mongo!;
  const c = m.collections;
  let svc: CommercialService;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    svc = new CommercialService({ cols: c, now });
    server = startInternalHttp({ host: '127.0.0.1', port: 0, internalAuth: createInternalAuth({ legacyKey: KEY }) }, svc);
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await m.db.dropDatabase();
    await m.close();
  });

  /** One full set of per-account rows for `acc` — every collection the purge has an opinion about. */
  async function seed(acc: string): Promise<void> {
    await c.wallets.insertOne({ _id: acc, coins: 50, rev: 1, gacha: { pity: {} }, subscription: { expiry: 9e12 }, totalRechargeCents: 499, updatedAt: 1 });
    await c.ledger.insertOne({ accountId: acc, delta: 50, balanceAfter: 50, reason: 'recharge', receiptId: `r-${acc}`, ts: 1 });
    await c.orders.insertOne({ _id: `o-${acc}`, accountId: acc, kind: 'shop', cost: 5, status: 'delivered', coinsAfter: 45, result: { itemId: 'x' }, ts: 1 });
    await c.recharges.insertOne({ _id: `paddle:txn-${acc}`, accountId: acc, platform: 'paddle', coinsGranted: 50, status: 'granted', rawReceipt: `txn-${acc}`, ts: 1, usdCents: 499 });
    await c.paddleEvents.insertOne({ _id: `txn-${acc}:transaction.completed`, transactionId: `txn-${acc}`, eventType: 'transaction.completed', accountId: acc, rawEvent: '{"customer":{"email":"x@y"}}', ts: 1 });
    await c.appleTransactionLinks.insertOne({ _id: `orig-${acc}`, accountId: acc, product: 'monthly_card', linkedAt: 1, updatedAt: 1 });
    await c.appleNotifications.insertOne({ _id: `n-${acc}`, notificationType: 'DID_RENEW', accountId: acc, outcome: 'granted', ts: 1 });
    await c.appleAccountTokens.insertOne({ _id: `tok-${acc}`, accountId: acc, createdAt: 1 });
    await c.appleConsumptionConsents.insertOne({ _id: acc, consented: true, ts: 1 });
    await c.gachaHistory.insertOne({ accountId: acc, poolId: 'std', orderId: `g-${acc}`, results: [], pityBefore: 0, pityAfter: 1, ts: 1 });
    await c.promoRedemptions.insertOne({ _id: `${acc}:WELCOME`, accountId: acc, code: 'WELCOME', coinsGranted: 10, ts: 1 });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    await seed('gone');
    await seed('other');
  });

  it('deletes non-payment state, keeps payment records with raw payloads blanked, leaves other accounts alone', async () => {
    const r = await svc.purgeAccount('gone');
    expect(r).toEqual({
      done: true,
      removed: { wallets: 1, gachaHistory: 1, promoRedemptions: 1, appleAccountTokens: 1, appleConsumptionConsents: 1 },
      minimized: { recharges: 1, paddleEvents: 1, appleTransactionLinks: 1 },
    });

    expect(await c.wallets.findOne({ _id: 'gone' })).toBeNull();
    expect(await c.gachaHistory.countDocuments({ accountId: 'gone' })).toBe(0);
    expect(await c.promoRedemptions.countDocuments({ accountId: 'gone' })).toBe(0);
    expect(await c.appleAccountTokens.countDocuments({ accountId: 'gone' })).toBe(0);
    expect(await c.appleConsumptionConsents.findOne({ _id: 'gone' })).toBeNull();

    // Retained, still attributable to the (now opaque) id, but carrying no raw provider payload.
    expect(await c.ledger.countDocuments({ accountId: 'gone' })).toBe(1);
    expect(await c.orders.countDocuments({ accountId: 'gone' })).toBe(1);
    expect(await c.appleNotifications.countDocuments({ accountId: 'gone' })).toBe(1);
    const rc = await c.recharges.findOne({ _id: 'paddle:txn-gone' });
    expect(rc).toMatchObject({ accountId: 'gone', usdCents: 499, rawReceipt: '' });
    expect(rc?.accountPurgedAt).toBeTypeOf('number');
    const pe = await c.paddleEvents.findOne({ _id: 'txn-gone:transaction.completed' });
    expect(pe).toMatchObject({ rawEvent: '' });
    expect(pe?.accountPurgedAt).toBeTypeOf('number');
    expect((await c.appleTransactionLinks.findOne({ _id: 'orig-gone' }))?.accountPurgedAt).toBeTypeOf('number');

    // The other account is untouched.
    expect(await c.wallets.findOne({ _id: 'other' })).not.toBeNull();
    expect(await c.recharges.findOne({ _id: 'paddle:txn-other' })).toMatchObject({ rawReceipt: 'txn-other' });
    expect(await c.paddleEvents.findOne({ _id: 'txn-other:transaction.completed' })).not.toHaveProperty('accountPurgedAt');
    expect(await c.appleTransactionLinks.findOne({ _id: 'orig-other' })).not.toHaveProperty('accountPurgedAt');
  });

  it('the retained recharge still does its job: a replayed receipt is refused, a refund stays idempotent', async () => {
    await svc.purgeAccount('gone');
    // Receipt dedupe keys on _id + accountId, so a replay by anyone else is still rejected.
    expect(await svc.paddleComplete({ accountId: 'thief', transactionId: 'txn-gone', coins: 50 })).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
    // Refund claims on refundedAt and does not re-create the deleted wallet (no upsert).
    expect(await svc.paddleRefund({ transactionId: 'txn-gone' })).toEqual({ ok: true, decrementedCents: 499 });
    expect(await c.wallets.findOne({ _id: 'gone' })).toBeNull();
    expect(await svc.paddleRefund({ transactionId: 'txn-gone' })).toEqual({ ok: true, decrementedCents: 0 });
  });

  it('is idempotent, keeps the first purge stamp, and re-strips a payload redelivered after the purge', async () => {
    await svc.purgeAccount('gone');
    const stamp = (await c.paddleEvents.findOne({ _id: 'txn-gone:transaction.completed' }))!.accountPurgedAt;

    const again = await svc.purgeAccount('gone');
    expect(again).toEqual({
      done: true,
      removed: { wallets: 0, gachaHistory: 0, promoRedemptions: 0, appleAccountTokens: 0, appleConsumptionConsents: 0 },
      minimized: { recharges: 0, paddleEvents: 0, appleTransactionLinks: 0 },
    });

    // Paddle redelivers at-least-once; a redelivery re-writes rawEvent, and the job's next run strips it.
    await svc.recordPaddleEvent({ transactionId: 'txn-gone', eventType: 'transaction.completed', accountId: 'gone', rawEvent: '{"again":1}' });
    const third = await svc.purgeAccount('gone');
    expect(third.minimized.paddleEvents).toBe(1);
    const pe = await c.paddleEvents.findOne({ _id: 'txn-gone:transaction.completed' });
    expect(pe).toMatchObject({ rawEvent: '', accountPurgedAt: stamp });
  });

  describe('HTTP', () => {
    it('no X-Internal-Key → 401, nothing deleted', async () => {
      const r = await fetch(`${base}/internal/accounts/gone/purge`, { method: 'POST' });
      expect(r.status).toBe(401);
      expect(await c.wallets.findOne({ _id: 'gone' })).not.toBeNull();
    });

    it('with key → 200 in the shared ok() envelope', async () => {
      const r = await fetch(`${base}/internal/accounts/gone/purge`, { method: 'POST', headers: { 'X-Internal-Key': KEY } });
      expect(r.status).toBe(200);
      expect(await jsonBody(r)).toMatchObject({ ok: true, data: { done: true, removed: { wallets: 1 } } });
    });

    it('GET → 404', async () => {
      const r = await fetch(`${base}/internal/accounts/gone/purge`, { headers: { 'X-Internal-Key': KEY } });
      expect(r.status).toBe(404);
    });
  });
});
