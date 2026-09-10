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

  it('survives a duplicate key on allocation, deterministically', async () => {
    // The case above races three real calls and passes, but it does NOT reach the 11000 handler: the
    // driver's ordering means the losers' findOne generally sees the winner's row and returns early,
    // so the recovery path was green by luck rather than by test. This forces it — a competing row is
    // inserted between the findOne and the insertOne, which is exactly what the loser of a real race
    // observes, and the unique index then produces the genuine driver error rather than a fake.
    let planted = false;
    const tokens = m.collections.appleAccountTokens;
    const cols = {
      ...m.collections,
      appleAccountTokens: Object.assign(Object.create(Object.getPrototypeOf(tokens) as object), tokens, {
        insertOne: async (doc: Parameters<typeof tokens.insertOne>[0]) => {
          if (!planted) {
            planted = true;
            await tokens.insertOne({ ...doc, _id: 'token-from-the-other-request' });
          }
          return tokens.insertOne(doc);
        },
      }) as typeof tokens,
    };
    const racy = new CommercialService({ cols, now, rng: zero });
    const r = await racy.appleAccountToken({ accountId: 'player-12' });
    expect(r).toMatchObject({ ok: true, token: 'token-from-the-other-request' });
    expect(await tokens.countDocuments({ accountId: 'player-12' })).toBe(1);
  });

  it('answers consumption_failed when Apple rejects the submission, and records it', async () => {
    // Best effort by design: losing our say in one refund decision must not turn into a non-2xx for
    // Apple (which would redeliver the same notification for hours) or a throw out of the webhook.
    await link('player-1');
    await svc.appleConsumptionConsent({ accountId: 'player-1', consented: true });
    const verifier = new SignedDataVerifier([], false, Environment.LOCAL_TESTING, BUNDLE, 1234);
    const failing = new CommercialService({
      cols: m.collections,
      now,
      rng: zero,
      appleServerApi: makeAppleServerApi({
        clients: {
          production: {
            getTransactionInfo: async () => ({}),
            getTransactionHistory: async () => ({}),
            sendConsumptionInformation: async () => { throw new Error('apple rejected the submission'); },
          },
          sandbox: {
            getTransactionInfo: async () => ({}),
            getTransactionHistory: async () => ({}),
            sendConsumptionInformation: async () => { throw new Error('apple rejected the submission'); },
          },
        },
        verifiers: { production: verifier, sandbox: verifier },
      }),
    });
    const res = await failing.appleNotification({
      signedPayload: signedNotification('CONSUMPTION_REQUEST', { uuid: 'consume-fail' }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'consumption_failed' });
    // The row is the only place anyone finds out this refund went unanswered.
    expect(await logOf('consume-fail')).toMatchObject({ outcome: 'consumption_failed' });
  });

  it('grants the renewal even when the diagnostic log row cannot be written', async () => {
    // The record() call sits AFTER the grant and is wrapped in a bare catch. This is what that catch
    // is for: the appleNotifications collection is a diagnostic trail, and losing a row must never
    // cost the player a period they paid for. Asserted by making the write fail outright.
    await link('player-1');
    const notifications = m.collections.appleNotifications;
    const cols = {
      ...m.collections,
      appleNotifications: Object.assign(Object.create(Object.getPrototypeOf(notifications) as object), notifications, {
        updateOne: async () => { throw new Error('collection unavailable'); },
      }) as typeof notifications,
    };
    const verifier = new SignedDataVerifier([], false, Environment.LOCAL_TESTING, BUNDLE, 1234);
    const { client } = fakeClients();
    const noLog = new CommercialService({
      cols,
      now,
      rng: zero,
      appleServerApi: makeAppleServerApi({
        clients: { production: client, sandbox: client },
        verifiers: { production: verifier, sandbox: verifier },
      }),
    });
    const res = await noLog.appleNotification({
      signedPayload: signedNotification('DID_RENEW', { uuid: 'nolog-1' }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'granted' });
    const wallet = await m.collections.wallets.findOne({ _id: 'player-1' });
    expect(wallet?.subscription?.expiry).toBeGreaterThan(now());
  });

  it('a year-card renewal grants a year, not a month', async () => {
    // grantPeriod picks days and immediate coins off the resolved product. The two SKUs differ by an
    // order of magnitude, so getting this branch wrong is a year paid for and a month delivered.
    await link('player-1');
    const monthly = await svc.appleNotification({ signedPayload: signedNotification('SUBSCRIBED') });
    expect(monthly).toMatchObject({ ok: true, outcome: 'granted' });
    const afterMonth = (await m.collections.wallets.findOne({ _id: 'player-1' }))!.subscription!.expiry;

    await m.db.dropDatabase();
    await m.ensureIndexes();
    await link('player-1');
    const yearly = await svc.appleNotification({
      signedPayload: signedNotification('SUBSCRIBED', {
        transaction: { productId: `${BUNDLE}.sub.year` },
      }),
    });
    expect(yearly).toMatchObject({ ok: true, outcome: 'granted' });
    const afterYear = (await m.collections.wallets.findOne({ _id: 'player-1' }))!.subscription!.expiry;

    // Not an exact day count (the grant is relative to `now()`, which ticks) — an order of magnitude,
    // which is what tells the two branches apart.
    expect(afterYear - now()).toBeGreaterThan((afterMonth - now()) * 5);
  });

  it('records a renewal whose grant was refused, rather than reporting it as granted', async () => {
    // The link table pointing at a different account than the one that already holds this
    // transaction's order (a support-side re-point, or an account merge, followed by a redelivery).
    // subscriptionCardBuy refuses on the orderId ownership check, and the outcome must reflect that:
    // reporting 'granted' here would put a period nobody received into the only record of the event.
    await link('player-1');
    expect(await svc.appleNotification({ signedPayload: signedNotification('DID_RENEW', { uuid: 'g-1' }) }))
      .toMatchObject({ ok: true, outcome: 'granted' });

    await m.collections.appleTransactionLinks.updateOne({ _id: 'orig-1' }, { $set: { accountId: 'player-2' } });
    const res = await svc.appleNotification({ signedPayload: signedNotification('DID_RENEW', { uuid: 'g-2' }) });
    expect(res).toMatchObject({ ok: true, outcome: 'ignored' });
    expect(await logOf('g-2')).toMatchObject({ outcome: 'ignored', accountId: 'player-2' });
    // ...and player-2 got nothing, which is the point of not calling it granted.
    expect(await m.collections.wallets.findOne({ _id: 'player-2' })).toBeNull();
  });

  it('refuses to invent a token when a duplicate key is not the accountId one', async () => {
    // The last line of appleAccountTokenFor: an 11000 whose winner cannot be found is not the race
    // this recovery exists for, and handing back a token nobody stored would split the player's
    // purchases across two identities in Apple's reports. The error is synthetic on purpose — a
    // collision on a randomUUID() _id cannot be produced, and pretending otherwise would be the
    // only way to reach the branch at all.
    const tokens = m.collections.appleAccountTokens;
    const cols = {
      ...m.collections,
      appleAccountTokens: Object.assign(Object.create(Object.getPrototypeOf(tokens) as object), tokens, {
        insertOne: async () => { throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); },
      }) as typeof tokens,
    };
    const svc2 = new CommercialService({ cols, now, rng: zero });
    await expect(svc2.appleAccountToken({ accountId: 'player-13' })).rejects.toThrow(/11000/);
  });

  it('reports an unverifiable payload without throwing', async () => {
    const res = await svc.appleNotification({ signedPayload: 'not-a-jws' });
    expect(res).toMatchObject({ ok: true, outcome: 'unverified' });
  });

  // The notification Apple's own "Request a Test Notification" button sends, and the one an operator
  // uses to prove the endpoint is reachable at all. It carries no signedTransactionInfo, so it lands
  // on the `!tx` branch — which had never been executed by any test, on the path whose entire job is
  // to answer "is this webhook wired up".
  it('records a TEST notification as ignored instead of failing on the missing transaction', async () => {
    const res = await svc.appleNotification({
      signedPayload: signedNotification('TEST', { uuid: 'test-1', transaction: null }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'ignored' });
    const row = await logOf('test-1');
    expect(row).toMatchObject({ notificationType: 'TEST', outcome: 'ignored' });
    // No account and no transaction to attribute it to — the row must not invent either.
    expect(row?.accountId).toBeUndefined();
    expect(row?.transactionId).toBeUndefined();
  });

  it.each(['DID_RENEW', 'SUBSCRIBED', 'REFUND'])(
    'a %s notification stripped of its transaction grants nothing',
    async (type) => {
      // A grant-shaped type with nothing to grant on. Fails closed on the same branch as TEST rather
      // than reaching resolveAccount with an undefined transaction.
      await link('player-1');
      const before = await m.collections.wallets.findOne({ _id: 'player-1' });
      const res = await svc.appleNotification({
        signedPayload: signedNotification(type, { uuid: `bare-${type}`, transaction: null }),
      });
      expect(res).toMatchObject({ ok: true, outcome: 'ignored' });
      const after = await m.collections.wallets.findOne({ _id: 'player-1' });
      expect(after?.subscription?.expiry ?? 0).toBe(before?.subscription?.expiry ?? 0);
    },
  );

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

// ── The number we actually send Apple in a refund dispute ────────────────────────────────────────
//
// The existing CONSUMPTION_REQUEST cases prove the consent gate and that a submission goes out. What
// they never exercised is the measurement itself: every one of them answers about a transaction with
// no recharge row, so `consumptionPercentage` returns undefined on its first line and the whole
// ledger walk below it had never run. That walk is the entire refund defence for a coin pack —
// "did they spend what they bought" — and it is the one field in the submission Apple weighs.
//
// Everything here goes through the real recharge and spend paths rather than hand-written rows: the
// only thing that can silently break this measurement is a shape change in `recharges` or `ledger`,
// and hand-written fixtures would keep passing through exactly that.
describe.skipIf(!mongo)('consumption data for a refund request', () => {
  const m = mongo!;
  let svc: CommercialService;
  let consumption: Array<{ transactionId: string; request: Record<string, unknown> }>;

  /** Coins the pack under test grants, chosen so the fractions below are exact. */
  const PACK_COINS = 1000;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    process.env.NW_IAP_BUNDLE = BUNDLE;

    const sent: Array<{ transactionId: string; request: Record<string, unknown> }> = [];
    consumption = sent;
    const client: AppleApiClientLike = {
      getTransactionInfo: async () => ({}),
      getTransactionHistory: async () => ({}),
      sendConsumptionInformation: async (transactionId, request) => {
        sent.push({ transactionId, request: request as unknown as Record<string, unknown> });
      },
    };
    const verifier = new SignedDataVerifier([], false, Environment.LOCAL_TESTING, BUNDLE, 1234);
    svc = new CommercialService({
      cols: m.collections,
      now,
      rng: zero,
      verifyReceipt: async () => ({ ok: true, coins: PACK_COINS }),
      appleServerApi: makeAppleServerApi({
        clients: { production: client, sandbox: client },
        verifiers: { production: verifier, sandbox: verifier },
      }),
    });
  });

  /**
   * Buy the coin pack the CONSUMPTION_REQUEST below will be about, and return what it granted.
   *
   * `receiptId` is `apple:<transactionId>` because that is what metaserver's iapVerify handler builds
   * (`${platform}:${receipt}`) and what `consumptionPercentage` looks up. A StoreKit 2 client sends a
   * bare transaction id, so the two agree; the retired StoreKit 1 path sent a base64 receipt blob,
   * whose row this lookup would not find — see the last case in this block.
   */
  async function buyPack(accountId: string, transactionId = 'tx-1'): Promise<number> {
    const r = await svc.rechargeVerify({
      accountId,
      platform: 'apple',
      receipt: transactionId,
      receiptId: `apple:${transactionId}`,
    });
    if (!r.ok) throw new Error(`rechargeVerify failed: ${r.error}`);
    return r.coinsGranted;
  }

  /**
   * Spend from inside the iOS app, which is the only place Apple-recharged coins CAN be spent
   * (ADR-020 channel isolation: an apple-funded balance is invisible to a `web` request). Asserting
   * the result matters — a spend that quietly failed on INSUFFICIENT_FUNDS would leave the ledger
   * empty and every percentage below reading a perfectly plausible 0.
   */
  async function spendCoins(accountId: string, amount: number, orderId: string): Promise<void> {
    const r = await svc.spend({ accountId, amount, reason: 'gacha', orderId, clientPlatform: 'ios' });
    if (!r.ok) throw new Error(`spend failed: ${r.error}`);
  }

  /** Ask for the refund answer for `tx-1`, with consent already on record. */
  async function askConsumption(accountId: string, uuid: string): Promise<void> {
    await svc.appleConsumptionConsent({ accountId, consented: true });
    await m.collections.appleTransactionLinks.insertOne({
      _id: 'orig-1', accountId, product: 'monthly_card', linkedAt: now(), updatedAt: now(),
    });
    const res = await svc.appleNotification({
      signedPayload: signedNotification('CONSUMPTION_REQUEST', { uuid, reason: 'UNINTENDED_PURCHASE' }),
    });
    expect(res).toMatchObject({ ok: true, outcome: 'consumption_sent' });
  }

  it('reports the share of the pack that was spent, in Apple milliunits', async () => {
    // The first purchase on an account is doubled (§6.5), so the pack under test is the SECOND one —
    // otherwise this asserts the bonus multiplier as much as the measurement.
    await buyPack('player-1', 'tx-0');
    const granted = await buyPack('player-1', 'tx-1');
    expect(granted).toBe(PACK_COINS); // no first-purchase bonus on this one

    await spendCoins('player-1', 250, 'o-1');
    await askConsumption('player-1', 'consume-25');

    expect(consumption).toHaveLength(1);
    expect(consumption[0]!.request).toMatchObject({
      customerConsented: true,
      consumptionPercentage: 25_000, // 250 / 1000 of a 100000-milliunit scale
      // Our own ledger says the coins arrived, which is what the app's side of the story is.
      deliveryStatus: 'DELIVERED',
      // No trial or sample of a coin pack exists to have offered — coins are the product itself.
      sampleContentProvided: false,
    });
  });

  it('caps at fully consumed rather than reporting more than 100%', async () => {
    // Spend is not attributable to a specific purchase, so a player with a prior balance can spend
    // more than this pack granted. Apple's field has no meaning above 100000.
    await buyPack('player-2', 'tx-0'); // doubled: 2000 coins of prior balance
    await buyPack('player-2', 'tx-1');
    await spendCoins('player-2', PACK_COINS * 2, 'o-2');
    await askConsumption('player-2', 'consume-full');
    expect(consumption[0]!.request.consumptionPercentage).toBe(100_000);
  });

  it('reports nothing consumed when the coins are still untouched', async () => {
    await buyPack('player-3', 'tx-0');
    await buyPack('player-3', 'tx-1');
    await askConsumption('player-3', 'consume-zero');
    // 0, not undefined: the pack IS delivered, and "delivered and unspent" is the strongest fact we
    // have for a refund we would not contest.
    expect(consumption[0]!.request).toMatchObject({
      consumptionPercentage: 0,
      deliveryStatus: 'DELIVERED',
    });
  });

  it('counts only spending that happened after the purchase', async () => {
    await buyPack('player-4', 'tx-0');
    // Spent out of the earlier pack, before the one being refunded was even bought.
    await spendCoins('player-4', 500, 'o-before');
    await buyPack('player-4', 'tx-1');
    await spendCoins('player-4', 100, 'o-after');
    await askConsumption('player-4', 'consume-after');
    // 100/1000, not 600/1000 — otherwise every long-standing player looks like they consumed
    // everything they ever bought, and a legitimate refund gets contested on our say-so.
    expect(consumption[0]!.request.consumptionPercentage).toBe(10_000);
  });

  it('omits the percentage — and says UNDELIVERED — for a transaction with no recharge row', async () => {
    // No purchase of ours matches this id, so there is nothing to measure against and the field is
    // left out (it is optional). This is also the shape a StoreKit 1 purchase produced: its
    // receiptId was `apple:<base64 receipt blob>`, which this lookup by transaction id cannot find.
    // Harmless now that the shipped client is StoreKit 2 and sends bare ids, and worth knowing if a
    // pre-StoreKit-2 purchase ever turns up in a refund request.
    await askConsumption('player-5', 'consume-none');
    expect(consumption[0]!.request).toMatchObject({
      customerConsented: true,
      deliveryStatus: 'UNDELIVERED_OTHER',
    });
    expect(consumption[0]!.request.consumptionPercentage).toBeUndefined();
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

  it('completes the purchase even when the link row cannot be written', async () => {
    // linkAppleSubscription is best-effort by design and its catch is bare. The asymmetry is the
    // whole argument: a missing link costs future renewals, which appAccountToken and the cold-start
    // sync both still cover, while a purchase refused because a bookkeeping row failed costs the sale
    // outright. Asserted by making the upsert fail.
    const links = m.collections.appleTransactionLinks;
    const cols = {
      ...m.collections,
      appleTransactionLinks: Object.assign(Object.create(Object.getPrototypeOf(links) as object), links, {
        updateOne: async () => { throw new Error('collection unavailable'); },
      }) as typeof links,
    };
    const noLink = new CommercialService({
      cols,
      now,
      rng: zero,
      verifyReceipt: async () => ({
        ok: true, coins: 0, product: 'monthly_card' as const, originalTransactionId: 'orig-1',
      }),
    });
    const bought = await noLink.verifyNonCoinReceipt({
      accountId: 'player-7',
      platform: 'apple',
      receipt: 'base64receipt==',
      receiptId: 'apple:tx-0',
      expectedProduct: 'monthly_card',
    });
    expect(bought.ok).toBe(true);
    expect(await links.findOne({ _id: 'orig-1' })).toBeNull();
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
