// App Store Server Notifications V2 — the webhook's decision table, end to end against real Mongo.
//
// Two things are being tested here and they are worth separating in your head:
//
//   • **The decode is real.** These tests build an actual `SignedDataVerifier` in
//     `Environment.LOCAL_TESTING` and feed it payloads signed with a throwaway ES256 key. Apple's
//     library skips only the certificate-chain check in that mode — its own payload validation, and
//     the bundleId / environment checks, still run. So a wrong assumption about the shape Apple sends
//     fails here rather than in production.
//     ⚠️ What this therefore does NOT prove: that a forged payload is rejected. Signature verification
//     is precisely the part LOCAL_TESTING skips, and Apple ships no fixtures for exercising it. That
//     path is Apple's code, covered by Apple's own tests; ours is everything after the decode.
//
//   • **The routing is the risky part.** A notification carries Apple's ids and nothing of ours, so
//     every case below is really the same question: does this event reach the right player's wallet,
//     exactly once, and does the wrong event reach nobody?
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';
import { makeAppleServerApi, type AppleApiClientLike } from '../src/iap/appleServerApi';
import type { RandInt } from '../src/gacha';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_applenotif_test';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[commercial.applenotif.e2e] Mongo unreachable (${URI}) — skipping.`);
}

// One connection is shared by both describes below, so it is closed once at file level — a per-describe
// afterAll would pull it out from under the next block.
afterAll(async () => {
  if (mongo) {
    await mongo.db.dropDatabase();
    await mongo.close();
  }
});

const BUNDLE = 'com.nw';
const zero: RandInt = () => 0;
let t = 1_700_000_000_000;
const now = () => t++;

// ── Signing throwaway payloads Apple's verifier will accept in LOCAL_TESTING ──────────────────────
const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const sign = (payload: object): string =>
  jwt.sign(JSON.stringify(payload), privateKey, { algorithm: 'ES256' });

function signedTransaction(over: Record<string, unknown> = {}): string {
  return sign({
    transactionId: 'tx-1',
    originalTransactionId: 'orig-1',
    bundleId: BUNDLE,
    productId: 'com.nw.sub.monthly',
    purchaseDate: 1_700_000_000_000,
    type: 'Auto-Renewable Subscription',
    environment: 'LocalTesting',
    signedDate: 1_700_000_000_000,
    ...over,
  });
}

function signedNotification(
  notificationType: string,
  over: { transaction?: Record<string, unknown> | null; uuid?: string; reason?: string } = {},
): string {
  const data: Record<string, unknown> = { environment: 'LocalTesting', bundleId: BUNDLE };
  if (over.transaction !== null) data.signedTransactionInfo = signedTransaction(over.transaction ?? {});
  if (over.reason) data.consumptionRequestReason = over.reason;
  return sign({
    notificationType,
    notificationUUID: over.uuid ?? `uuid-${notificationType}-${Math.random().toString(36).slice(2)}`,
    version: '2.0',
    signedDate: 1_700_000_000_000,
    data,
  });
}

/** Apple's outbound client is never reached by these tests except for sendConsumption. */
function fakeClients(): { client: AppleApiClientLike; consumption: unknown[] } {
  const consumption: unknown[] = [];
  const client: AppleApiClientLike = {
    getTransactionInfo: async () => ({}),
    getTransactionHistory: async () => ({}),
    sendConsumptionInformation: async (transactionId, request) => {
      consumption.push({ transactionId, request });
    },
  };
  return { client, consumption };
}

describe.skipIf(!mongo)('App Store Server Notifications V2 (e2e)', () => {
  const m = mongo!;
  let svc: CommercialService;
  let consumption: unknown[];

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    process.env.NW_IAP_BUNDLE = BUNDLE;

    const { client, consumption: sent } = fakeClients();
    consumption = sent;
    // Real verifier, fake transport: the decode below is Apple's actual code path.
    const verifier = new SignedDataVerifier([], false, Environment.LOCAL_TESTING, BUNDLE, 1234);
    const appleServerApi = makeAppleServerApi({
      clients: { production: client, sandbox: client },
      verifiers: { production: verifier, sandbox: verifier },
    });

    svc = new CommercialService({ cols: m.collections, now, rng: zero, appleServerApi });
  });

  /** Pretend the player once bought this subscription through the app, which is what writes the link. */
  async function link(accountId: string, originalTransactionId = 'orig-1'): Promise<void> {
    await m.collections.appleTransactionLinks.insertOne({
      _id: originalTransactionId,
      accountId,
      product: 'monthly_card',
      linkedAt: now(),
      updatedAt: now(),
    });
  }

  const logOf = (uuid: string) => m.collections.appleNotifications.findOne({ _id: uuid });

  /** The account's appAccountToken, asserting the handler's own Result envelope on the way through. */
  async function tokenFor(accountId: string): Promise<string> {
    const r = await svc.appleAccountToken({ accountId });
    if (!r.ok) throw new Error(`appleAccountToken failed: ${r.error}`);
    return r.token;
  }

  it('DID_RENEW extends the subscription of the linked account', async () => {
    await link('player-1');
    const res = await svc.appleNotification({ signedPayload: signedNotification('DID_RENEW') });
    expect(res).toMatchObject({ ok: true, outcome: 'granted' });

    const wallet = await m.collections.wallets.findOne({ _id: 'player-1' });
    expect(wallet?.subscription?.expiry).toBeGreaterThan(now());
  });

  it('SUBSCRIBED grants too — the first period arrives as a notification like any other', async () => {
    await link('player-1');
    const res = await svc.appleNotification({ signedPayload: signedNotification('SUBSCRIBED') });
    expect(res).toMatchObject({ ok: true, outcome: 'granted' });
  });

  it('grants a renewal even though the current card is still running', async () => {
    // Apple bills about a day BEFORE the period ends, so every renewal arrives while the previous one
    // is active. If the single-slot gate applied here, the player would be charged and given nothing.
    await link('player-1');
    await svc.appleNotification({ signedPayload: signedNotification('SUBSCRIBED') });
    const before = (await m.collections.wallets.findOne({ _id: 'player-1' }))!.subscription!.expiry;

    const res = await svc.appleNotification({
      signedPayload: signedNotification('DID_RENEW', { transaction: { transactionId: 'tx-2' } }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'granted' });
    const after = (await m.collections.wallets.findOne({ _id: 'player-1' }))!.subscription!.expiry;
    expect(after).toBeGreaterThan(before);
  });

  it('redelivery of the same transaction grants exactly once', async () => {
    // Apple redelivers at-least-once, and the cold-start sync covers the same periods independently.
    // `apple:<transactionId>` is the shared idempotency key that makes the overlap free.
    await link('player-1');
    await svc.appleNotification({ signedPayload: signedNotification('DID_RENEW', { uuid: 'u1' }) });
    const first = (await m.collections.wallets.findOne({ _id: 'player-1' }))!.subscription!.expiry;

    await svc.appleNotification({ signedPayload: signedNotification('DID_RENEW', { uuid: 'u2' }) });
    const second = (await m.collections.wallets.findOne({ _id: 'player-1' }))!.subscription!.expiry;
    expect(second).toBe(first);
  });

  it('records — rather than drops — a renewal it cannot route to an account', async () => {
    // No link row: Apple charged someone we cannot name. This log row is the only trace anyone gets.
    const payload = signedNotification('DID_RENEW', { uuid: 'orphan' });
    const res = await svc.appleNotification({ signedPayload: payload });
    expect(res).toMatchObject({ ok: true, outcome: 'unlinked' });

    const row = await logOf('orphan');
    expect(row).toMatchObject({ outcome: 'unlinked', originalTransactionId: 'orig-1' });
    // Absent, not null: support looks these up with `{ accountId: { $exists: false } }`.
    expect(await m.collections.appleNotifications.countDocuments({ accountId: { $exists: false } })).toBe(1);
  });

  it('does not claw back days on REFUND — same posture as the web channel', async () => {
    await link('player-1');
    await svc.appleNotification({ signedPayload: signedNotification('SUBSCRIBED') });
    const granted = (await m.collections.wallets.findOne({ _id: 'player-1' }))!.subscription!.expiry;

    const res = await svc.appleNotification({
      signedPayload: signedNotification('REFUND', { uuid: 'refund-1', transaction: { revoked: true } }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'ignored' });
    const after = (await m.collections.wallets.findOne({ _id: 'player-1' }))!.subscription!.expiry;
    expect(after).toBe(granted);
    expect(await logOf('refund-1')).toMatchObject({ outcome: 'ignored', accountId: 'player-1' });
  });

  it.each(['EXPIRED', 'DID_FAIL_TO_RENEW', 'GRACE_PERIOD_EXPIRED', 'REVOKE', 'PRICE_INCREASE'])(
    '%s is recorded and grants nothing',
    async (type) => {
      await link('player-1');
      const res = await svc.appleNotification({ signedPayload: signedNotification(type, { uuid: `u-${type}` }) });
      expect(res).toMatchObject({ ok: true, outcome: 'ignored' });
      expect(await m.collections.wallets.findOne({ _id: 'player-1' })).toBeNull();
      expect(await logOf(`u-${type}`)).toMatchObject({ notificationType: type, outcome: 'ignored' });
    },
  );

  it('never grants a revoked transaction, even on DID_RENEW', async () => {
    await link('player-1');
    const res = await svc.appleNotification({
      signedPayload: signedNotification('DID_RENEW', { transaction: { revocationDate: 1_700_000_100_000 } }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'ignored' });
    expect(await m.collections.wallets.findOne({ _id: 'player-1' })).toBeNull();
  });

  it('a coin-pack product on a renewal notification grants no subscription', async () => {
    await link('player-1');
    const res = await svc.appleNotification({
      signedPayload: signedNotification('DID_RENEW', { transaction: { productId: 'com.nw.coins.t499' } }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'ignored' });
  });

  it('routes by appAccountToken with no link row at all', async () => {
    // The hole appAccountToken exists to close: the purchase was charged and never reported, so
    // nothing ever wrote a link. The token was recorded BEFORE the purchase, so the renewal still
    // finds its owner.
    const token = await tokenFor('player-7');
    const res = await svc.appleNotification({
      signedPayload: signedNotification('DID_RENEW', {
        uuid: 'by-token',
        transaction: { appAccountToken: token },
      }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'granted' });
    expect(await logOf('by-token')).toMatchObject({ accountId: 'player-7' });
    const wallet = await m.collections.wallets.findOne({ _id: 'player-7' });
    expect(wallet?.subscription?.expiry).toBeGreaterThan(now());
  });

  it('falls back to the link table when the token is one we never issued', async () => {
    // A token from another environment, or a corrupted one: it must not route anywhere by itself,
    // and it must not stop the link table from answering.
    await link('player-1');
    const res = await svc.appleNotification({
      signedPayload: signedNotification('DID_RENEW', {
        uuid: 'unknown-token',
        transaction: { appAccountToken: '11111111-2222-3333-4444-555555555555' },
      }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'granted' });
    expect(await logOf('unknown-token')).toMatchObject({ accountId: 'player-1' });
  });

  it('CONSUMPTION_REQUEST sends nothing until the player has consented', async () => {
    // Apple rejects a submission reporting customerConsented:false and tells you not to respond at
    // all in that case. So an account that was never asked, or that declined, produces silence rather
    // than a claim of consent nobody gave. The row records that the request arrived.
    await link('player-1');
    const res = await svc.appleNotification({
      signedPayload: signedNotification('CONSUMPTION_REQUEST', {
        uuid: 'consume-1',
        reason: 'UNINTENDED_PURCHASE',
      }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'consumption_no_consent' });
    expect(consumption).toHaveLength(0);
    expect(await logOf('consume-1')).toMatchObject({
      outcome: 'consumption_no_consent',
      consumptionRequestReason: 'UNINTENDED_PURCHASE',
    });
  });

  it('CONSUMPTION_REQUEST answers Apple once the player has consented', async () => {
    // The other half of the gate above: with consent stored (the app asked, the player allowed), the
    // ledger-derived consumption report actually goes out — this is the refund defence firing.
    await link('player-1');
    await svc.appleConsumptionConsent({ accountId: 'player-1', consented: true });
    const res = await svc.appleNotification({
      signedPayload: signedNotification('CONSUMPTION_REQUEST', {
        uuid: 'consume-2',
        reason: 'UNINTENDED_PURCHASE',
      }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'consumption_sent' });
    expect(consumption).toHaveLength(1);
    expect(consumption[0]).toMatchObject({
      transactionId: 'tx-1',
      request: { customerConsented: true },
    });
  });

  it('a declined consent is a stored answer, not a missing one — still no submission', async () => {
    await link('player-1');
    await svc.appleConsumptionConsent({ accountId: 'player-1', consented: false });
    const res = await svc.appleNotification({
      signedPayload: signedNotification('CONSUMPTION_REQUEST', { uuid: 'consume-3' }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'consumption_no_consent' });
    expect(consumption).toHaveLength(0);
  });

  it('hands out one appAccountToken per account, however often it is asked', async () => {
    // Two tokens for one player would split their purchases across two identities in Apple's
    // reports, and the second would resolve to nothing until a link row happened to exist.
    const a = await tokenFor('player-9');
    const b = await tokenFor('player-9');
    expect(b).toBe(a);
    expect(await m.collections.appleAccountTokens.countDocuments({ accountId: 'player-9' })).toBe(1);
    expect(await tokenFor('player-10')).not.toBe(a);
  });

  it('survives concurrent first asks for the same account', async () => {
    // Two /bootstrap calls can race (the client polls, and a login can land mid-poll). The unique
    // index makes the loser read the winner's row instead of minting a second token.
    const tokens = await Promise.all([
      tokenFor('player-11'),
      tokenFor('player-11'),
      tokenFor('player-11'),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(await m.collections.appleAccountTokens.countDocuments({ accountId: 'player-11' })).toBe(1);
  });

  it('reports an unverifiable payload without throwing', async () => {
    const res = await svc.appleNotification({ signedPayload: 'not-a-jws' });
    expect(res).toMatchObject({ ok: true, outcome: 'unverified' });
  });

  it('rejects a payload for a different app', async () => {
    // bundleId is checked by Apple's verifier; a validly-signed notification for someone else's app
    // must not reach our wallets.
    const foreign = sign({
      notificationType: 'DID_RENEW',
      notificationUUID: 'foreign',
      version: '2.0',
      signedDate: 1_700_000_000_000,
      data: { environment: 'LocalTesting', bundleId: 'com.someone.else' },
    });
    const res = await svc.appleNotification({ signedPayload: foreign });
    expect(res).toMatchObject({ ok: true, outcome: 'unverified' });
  });

  it('grants nothing when Apple is unconfigured', async () => {
    const unconfigured = new CommercialService({ cols: m.collections, now, rng: zero });
    const res = await unconfigured.appleNotification({ signedPayload: signedNotification('DID_RENEW') });
    expect(res).toMatchObject({ ok: false });
  });
});

// ── The link the whole mechanism hangs on ─────────────────────────────────────────────────────────
//
// A renewal notification carries Apple's originalTransactionId and nothing of ours, so it can only be
// routed if the purchase wrote down who bought it. These two facts are recorded in one test on
// purpose: they are a single mechanism, and a change that breaks the pairing would otherwise pass
// both halves' own tests.
describe.skipIf(!mongo)('purchase → link → renewal', () => {
  const m = mongo!;
  let svc: CommercialService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    process.env.NW_IAP_BUNDLE = BUNDLE;

    const { client } = fakeClients();
    const verifier = new SignedDataVerifier([], false, Environment.LOCAL_TESTING, BUNDLE, 1234);
    svc = new CommercialService({
      cols: m.collections,
      now,
      rng: zero,
      // What the App Store Server API answers for the player's original purchase.
      verifyReceipt: async () => ({
        ok: true,
        coins: 0,
        product: 'monthly_card' as const,
        originalTransactionId: 'orig-1',
      }),
      appleServerApi: makeAppleServerApi({
        clients: { production: client, sandbox: client },
        verifiers: { production: verifier, sandbox: verifier },
      }),
    });
  });

  it('records the account when the subscription is bought, and routes its renewal months later', async () => {
    const bought = await svc.verifyNonCoinReceipt({
      accountId: 'player-7',
      platform: 'apple',
      receipt: 'base64receipt==',
      receiptId: 'apple:tx-0',
      expectedProduct: 'monthly_card',
    });
    expect(bought.ok).toBe(true);
    expect(await m.collections.appleTransactionLinks.findOne({ _id: 'orig-1' })).toMatchObject({
      accountId: 'player-7',
      product: 'monthly_card',
    });

    // Now the renewal arrives on its own, with no request from the player and no session to identify.
    const res = await svc.appleNotification({
      signedPayload: signedNotification('DID_RENEW', { transaction: { transactionId: 'tx-renewal' } }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'granted' });
    const wallet = await m.collections.wallets.findOne({ _id: 'player-7' });
    expect(wallet?.subscription?.expiry).toBeGreaterThan(now());
  });

  it('re-asserts the link on a repeat verification rather than failing on the duplicate key', async () => {
    // Restore Purchases, a reinstall, or simply buying again after the card lapsed all re-verify the
    // same original transaction. The link must heal, not throw.
    const args = {
      accountId: 'player-7',
      platform: 'apple',
      receipt: 'base64receipt==',
      expectedProduct: 'monthly_card' as const,
    };
    await svc.verifyNonCoinReceipt({ ...args, receiptId: 'apple:tx-0' });
    await svc.verifyNonCoinReceipt({ ...args, receiptId: 'apple:tx-1' });
    expect(await m.collections.appleTransactionLinks.countDocuments({ _id: 'orig-1' })).toBe(1);
  });

  it('does not link a starter pack — one-shot SKUs never produce a renewal to route', async () => {
    const starterSvc = new CommercialService({
      cols: m.collections,
      now,
      rng: zero,
      verifyReceipt: async () => ({
        ok: true,
        coins: 0,
        product: 'starter_draw' as const,
        originalTransactionId: 'orig-starter',
      }),
    });
    await starterSvc.verifyNonCoinReceipt({
      accountId: 'player-8',
      platform: 'apple',
      receipt: 'r',
      receiptId: 'apple:tx-s',
      expectedProduct: 'starter_draw',
    });
    expect(await m.collections.appleTransactionLinks.findOne({ _id: 'orig-starter' })).toBeNull();
  });
});
