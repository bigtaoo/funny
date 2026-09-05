// POST /iap/apple/sync — the route that turns an Apple auto-renewal into 30 more days
// (src/service/economy/subscriptions.ts's iapAppleSyncHandler, IOS_RELEASE.md §4.1b).
//
// This endpoint is unlike every other money route in the package, and each difference is a way it
// could be wrong without anyone finding out:
//
//   * **Nobody asked for the request.** The client fires it on cold start, so a failure has no user
//     to be reported to and no retry loop watching it. Whatever this handler does on a bad day, it
//     does silently — which is exactly why "does it return 200 with granted:0" deserves a case
//     rather than a shrug.
//   * **It is the only route that can grant a subscription the player did not just buy**, so the
//     receipt has to reach commercial verbatim; anything the handler invented instead would either
//     grant nothing or grant the wrong account's period.
//   * **`granted` is almost always 0.** The interesting path — a period actually landing and the
//     save picking up the new expiry — runs about once a month per paying player, i.e. never during
//     manual testing.
//
// Handlers are called directly against real Mongo, same harness and reasons as
// economy-branch-subscriptions.test.ts (see economy-branch-fakes.ts's header).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createMongo, makeNewSave, type MongoHandle } from '@nw/shared';
import { iapAppleSyncHandler } from '../src/service/economy/subscriptions.js';
import { BranchCommercial, makeCore, mkReply, mkReq } from './economy-branch-fakes.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_applesync_test';
const NOW = 1_800_000_000_000;

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[iapAppleSync] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('POST /iap/apple/sync', () => {
  const m = mongo!;
  let accountId: string;
  let comm: BranchCommercial;
  let core: ReturnType<typeof makeCore>;

  const data = (r: unknown) => (r as { data: { save: { monetization?: { subscriptionExpiry?: number } }; granted: number } }).data;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    accountId = `acc-${randomUUID()}`;
    comm = new BranchCommercial();
    comm.populateWallet = true;
    core = makeCore({ cols: m.collections, commercial: comm, now: () => NOW });
    const save = makeNewSave(accountId, NOW);
    await m.collections.saves.updateOne(
      { _id: accountId },
      { $setOnInsert: { _id: accountId, save, rev: save.rev } },
      { upsert: true },
    );
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('nothing new: 200 with granted 0, and the save comes back untouched', async () => {
    // The answer on all but one launch a month. It must still be a success — a 4xx here would put a
    // permanent error in the client log of every healthy player.
    const { reply, get } = mkReply();
    const res = await iapAppleSyncHandler(core, mkReq(accountId, { receipt: 'RCPT' }, 'ios'), reply);
    expect(get()).toBeUndefined();                       // no reply.code() — handler returned ok()
    expect(data(res).granted).toBe(0);
    expect(data(res).save.monetization?.subscriptionExpiry ?? 0).toBe(0);
  });

  it('a renewal lands: granted is reported and the new expiry is mirrored into the save', async () => {
    comm.syncGranted = 1;
    const { reply } = mkReply();
    const res = await iapAppleSyncHandler(core, mkReq(accountId, { receipt: 'RCPT' }, 'ios'), reply);
    expect(data(res).granted).toBe(1);
    expect(data(res).save.monetization?.subscriptionExpiry).toBe(30 * 86400000);
    // The mirror is the whole point: the client adopts this save, so a granted period that never
    // reached the save would show the player an expired card they had just been charged for.
    const stored = await m.collections.saves.findOne({ _id: accountId });
    expect(stored?.save.monetization?.subscriptionExpiry).toBe(30 * 86400000);
  });

  it('several missed renewals arrive together', async () => {
    // The three-months-offline case the full-history read exists for (iap/apple.ts).
    comm.syncGranted = 3;
    const { reply } = mkReply();
    const res = await iapAppleSyncHandler(core, mkReq(accountId, { receipt: 'RCPT' }, 'ios'), reply);
    expect(data(res).granted).toBe(3);
    expect(data(res).save.monetization?.subscriptionExpiry).toBe(3 * 30 * 86400000);
  });

  it('the receipt is forwarded verbatim, with the declared platform', async () => {
    // Verbatim because commercial hands it to Apple; the platform because it decides which recharged
    // bucket the period's coins land in (ADR-020) — an ios session must not fund the web pool.
    const { reply } = mkReply();
    await iapAppleSyncHandler(core, mkReq(accountId, { receipt: 'BASE64-RECEIPT' }, 'ios'), reply);
    expect(comm.syncCalls).toEqual([{ accountId, receipt: 'BASE64-RECEIPT', clientPlatform: 'ios' }]);
  });

  it('no receipt in the body: 400, and commercial is never called', async () => {
    const { reply, get } = mkReply();
    await iapAppleSyncHandler(core, mkReq(accountId, {}, 'ios'), reply);
    expect(get()?.code).toBe(400);
    expect(comm.syncCalls).toEqual([]);
  });

  it('an entirely absent body is the same 400, not a crash', async () => {
    // Reachable in practice: the openapi schema guards the deployed route, but this handler is also
    // called directly (and the body destructure would throw on undefined without the ?? {}).
    const { reply, get } = mkReply();
    await iapAppleSyncHandler(core, mkReq(accountId, undefined, 'ios'), reply);
    expect(get()?.code).toBe(400);
    expect(comm.syncCalls).toEqual([]);
  });

  it('commercial down: 503 from the shared gate, nothing invented locally', async () => {
    const down = makeCore({ cols: m.collections, commercial: new BranchCommercial(false), now: () => NOW });
    const { reply, get } = mkReply();
    await iapAppleSyncHandler(down, mkReq(accountId, { receipt: 'RCPT' }, 'ios'), reply);
    expect(get()?.code).toBe(503);
  });

  it('commercial refuses: 400, and the save is not touched', async () => {
    comm.nextSubscriptionError = 'BAD_REQUEST';
    const { reply, get } = mkReply();
    await iapAppleSyncHandler(core, mkReq(accountId, { receipt: 'RCPT' }, 'ios'), reply);
    expect(get()?.code).toBe(400);
    const stored = await m.collections.saves.findOne({ _id: accountId });
    expect(stored?.save.monetization?.subscriptionExpiry ?? 0).toBe(0);
  });

  it('a granted period still succeeds when the wallet read afterwards fails', async () => {
    // commercial has already applied the period; refusing the response here would tell the client
    // nothing happened, and the client would then never adopt the save. Degrade, do not fail.
    comm.syncGranted = 1;
    comm.populateWallet = false;
    comm.walletUnavailable = true;
    const { reply, get } = mkReply();
    const res = await iapAppleSyncHandler(core, mkReq(accountId, { receipt: 'RCPT' }, 'ios'), reply);
    expect(get()).toBeUndefined();
    expect(data(res).granted).toBe(1);
  });
});
