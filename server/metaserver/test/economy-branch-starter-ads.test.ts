// Branch-coverage backfill for src/service/economy/{starter,adsPromo}.ts (2026-09-03). Adds the
// branches test/economy-service-unit.test.ts's route-level scenarios never take: the second half of
// each `!a || !b` input guard (a route schema rejects those before the handler sees them), a
// non-ALREADY_PURCHASED starter refusal, a starter purchase whose post-buy wallet read fails, a
// signed non-dev ad platform, a non-string promo `code`, and a promo error absent from the status map.
// Handlers are called directly (see test/economy-branch-fakes.ts) against real Mongo (rs0, DB
// nw_meta_grpC_branch_test) because the starter_draw path delivers through deliverOrder.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createMongo, makeNewSave, type MongoHandle, type SaveData,
  PRODUCT_STARTER_GROWTH, GROWTH_PACK_WINDOW_DAYS, ADS_REWARD_COINS, ADS_DAILY_CAP, ADS_MIN_INTERVAL_MS,
} from '@nw/shared';
import { starterBuyHandler } from '../src/service/economy/starter.js';
import { adsRewardHandler, iapVerifyHandler, redeemPromoCodeHandler } from '../src/service/economy/adsPromo.js';
import { BranchCommercial, makeCore, mkReply, mkReq } from './economy-branch-fakes.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_grpC_branch_test';
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
if (!mongo) console.warn(`[economy-branch-starter-ads] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('service/economy/{starter,adsPromo}.ts branch backfill', () => {
  const m = mongo!;
  let accountId: string;
  let comm: BranchCommercial;
  let core: ReturnType<typeof makeCore>;
  let now = NOW;

  const data = (r: unknown) => (r as { data: Record<string, never> }).data;
  const downCore = () => makeCore({ cols: m.collections, commercial: new BranchCommercial(false), now: () => now });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    // Fresh accountId per test: the ad cooldown/daily-cap counters fall back to an in-process store
    // when `redis` is null and are not reset between tests.
    accountId = `acc-${randomUUID()}`;
    now = NOW;
    comm = new BranchCommercial();
    core = makeCore({ cols: m.collections, commercial: comm, now: () => now });
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

  // ── starter.ts ─────────────────────────────────────────────────────────────────────────────────
  describe('starterBuyHandler', () => {
    const buy = (body: unknown, c = core) => {
      const { reply, get } = mkReply();
      return starterBuyHandler(c, mkReq(accountId, body), reply).then((out) => ({ out, sent: get() }));
    };

    it('commercial not configured -> 503', async () => {
      const { sent } = await buy({ productId: 'starter_draw', platform: 'ios', receipt: 'product:starter_draw' }, downCore());
      expect(sent?.code).toBe(503);
    });

    it('a productId that is neither starter pack -> 400 (both halves of the productId guard)', async () => {
      const { sent } = await buy({ productId: 'monthly_card', platform: 'ios', receipt: 'x' });
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.message).toBe('invalid productId');
    });

    it('starter_draw with a platform but no receipt -> 400 (the second half of the receipt guard)', async () => {
      const { sent } = await buy({ productId: 'starter_draw', platform: 'ios' });
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.message).toBe('missing platform/receipt');
    });

    it('growth pack with a receipt but no platform -> 400 (the first half of the same guard)', async () => {
      const { sent } = await buy({ productId: PRODUCT_STARTER_GROWTH, receipt: 'product:starter_growth' });
      expect(sent?.code).toBe(400);
    });

    it('growth pack outside the account-age window -> 403, never charged', async () => {
      await m.collections.accounts.updateOne(
        { _id: accountId },
        { $setOnInsert: { _id: accountId, createdAt: NOW - (GROWTH_PACK_WINDOW_DAYS + 1) * 86400000 } },
        { upsert: true },
      );
      const { sent } = await buy({ productId: PRODUCT_STARTER_GROWTH, platform: 'ios', receipt: 'product:starter_growth' });
      expect(sent?.code).toBe(403);
      expect(comm.starterUsed).toEqual([]);
    });

    it('growth pack with an account row still inside the window -> allowed', async () => {
      await m.collections.accounts.updateOne(
        { _id: accountId },
        { $setOnInsert: { _id: accountId, createdAt: NOW - 86400000 } },
        { upsert: true },
      );
      const { sent } = await buy({ productId: PRODUCT_STARTER_GROWTH, platform: 'ios', receipt: 'product:starter_growth' });
      expect(sent).toBeUndefined();
      expect(comm.starterUsed).toEqual([PRODUCT_STARTER_GROWTH]);
    });

    it('growth pack with no account row at all -> allowed (best-effort window check)', async () => {
      const { sent } = await buy({ productId: PRODUCT_STARTER_GROWTH, platform: 'ios', receipt: 'product:starter_growth' });
      expect(sent).toBeUndefined();
    });

    it('receipt that resolves to the other pack -> 400 INVALID_RECEIPT, nothing granted', async () => {
      const { sent } = await buy({ productId: 'starter_draw', platform: 'ios', receipt: 'product:starter_growth' });
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.code).toBe('INVALID_RECEIPT');
      expect(comm.starterUsed).toEqual([]);
    });

    it('ALREADY_PURCHASED -> 409 (a distinct code so the client can say "you already own this")', async () => {
      comm.nextStarterError = 'ALREADY_PURCHASED';
      const { sent } = await buy({ productId: 'starter_draw', platform: 'ios', receipt: 'product:starter_draw' });
      expect(sent?.code).toBe(409);
      expect(sent?.payload.error?.code).toBe('ALREADY_PURCHASED');
    });

    it('any other starter refusal -> 400 BAD_REQUEST with the raw reason', async () => {
      comm.nextStarterError = 'STARTER_WINDOW_CLOSED';
      const { sent } = await buy({ productId: 'starter_draw', platform: 'ios', receipt: 'product:starter_draw' });
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.message).toBe('STARTER_WINDOW_CLOSED');
    });

    it('starter_draw happy path: the pack items are delivered and badged new/duplicate', async () => {
      const { out, sent } = await buy({ productId: 'starter_draw', platform: 'ios', receipt: 'product:starter_draw' });
      expect(sent).toBeUndefined();
      expect(data(out).results).toEqual([{ itemId: 'skin_l1', rarity: 'legendary', duplicate: false }]);
      const stored = (await m.collections.saves.findOne({ _id: accountId }))!.save;
      expect(stored.inventory.skins).toContain('skin_l1');
    });

    it('starter_draw of a skin only in the everOwned ledger is badged duplicate but still delivered', async () => {
      // The `before.everOwned?.skin ?? []` side that actually has a ledger: a skin sold via auction
      // escrow is gone from inventory.skins yet must not show a NEW badge when it comes back.
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.everOwned': { skin: ['skin_l1'], hero: [], equipment: [], material: [] } } },
      );
      const { out } = await buy({ productId: 'starter_draw', platform: 'ios', receipt: 'product:starter_draw' });
      expect(data(out).results).toEqual([{ itemId: 'skin_l1', rarity: 'legendary', duplicate: true }]);
      const stored = (await m.collections.saves.findOne({ _id: accountId }))!.save;
      expect(stored.inventory.skins).toContain('skin_l1'); // re-added despite being a duplicate
    });

    it('socialsvc not configured: the pack still delivers (mail is only needed for overflow)', async () => {
      const noSocial = makeCore({ cols: m.collections, commercial: comm, now: () => now, socialsvc: null });
      const { sent } = await buy({ productId: 'starter_draw', platform: 'ios', receipt: 'product:starter_draw' }, noSocial);
      expect(sent).toBeUndefined();
      const stored = (await m.collections.saves.findOne({ _id: accountId }))!.save;
      expect(stored.inventory.skins).toContain('skin_l1');
    });

    it('growth pack grants no items at all (deliverOrder is skipped entirely)', async () => {
      const { out } = await buy({ productId: PRODUCT_STARTER_GROWTH, platform: 'ios', receipt: 'product:starter_growth' });
      expect(data(out).results).toEqual([]);
      expect(comm.delivered).toEqual([]);
    });

    it('purchase succeeds but the wallet read fails -> still ok, the mirror is left for the next GET /save', async () => {
      comm.walletUnavailable = true;
      const { out, sent } = await buy({ productId: 'starter_draw', platform: 'ios', receipt: 'product:starter_draw' });
      expect(sent).toBeUndefined();
      expect((data(out).save as unknown as SaveData).accountId).toBe(accountId);
      expect(comm.starterUsed).toEqual(['starter_draw']);
    });

    it('wallet embedded in the buy response -> mirrored without a second round trip', async () => {
      comm.populateWallet = true;
      const { out } = await buy({ productId: PRODUCT_STARTER_GROWTH, platform: 'ios', receipt: 'product:starter_growth' });
      expect((data(out).save as unknown as SaveData).monetization?.starterUsed).toEqual([PRODUCT_STARTER_GROWTH]);
    });
  });

  // ── adsPromo.ts: adsRewardHandler ──────────────────────────────────────────────────────────────
  describe('adsRewardHandler', () => {
    const watch = (body: unknown, c = core) => {
      const { reply, get } = mkReply();
      return adsRewardHandler(c, mkReq(accountId, body), reply).then((out) => ({ out, sent: get() }));
    };

    it('commercial not configured -> 503', async () => {
      const { sent } = await watch({ adToken: 'tok' }, downCore());
      expect(sent?.code).toBe(503);
    });

    it('missing adToken -> 400 before any cap or cooldown is consumed', async () => {
      const { sent } = await watch({});
      expect(sent?.code).toBe(400);
      expect(comm.bal(accountId)).toBe(0);
    });

    it('platform omitted defaults to dev, which skips signature verification', async () => {
      const { out, sent } = await watch({ adToken: `tok-${randomUUID()}` });
      expect(sent).toBeUndefined();
      expect(data(out).granted).toBe(ADS_REWARD_COINS);
      expect(comm.bal(accountId)).toBe(ADS_REWARD_COINS);
    });

    it('a real ad platform is signature-checked and, when it verifies, credited', async () => {
      // admob_client with no NW_ADMOB_CLIENT_KEY configured verifies by design (the daily cap plus
      // token uniqueness carry the weight) — the non-dev arm of the platform gate still runs.
      const { out, sent } = await watch({ adToken: `tok-${randomUUID()}`, platform: 'admob_client' });
      expect(sent).toBeUndefined();
      expect(data(out).granted).toBe(ADS_REWARD_COINS);
    });

    it('an unrecognized platform fails signature verification -> 400, no coins', async () => {
      const { sent } = await watch({ adToken: `tok-${randomUUID()}`, platform: 'not_a_platform' });
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.message).toBe('invalid ad signature');
      expect(comm.bal(accountId)).toBe(0);
    });

    it('replaying the same adToken -> 400 duplicate, credited only once', async () => {
      const token = `tok-${randomUUID()}`;
      await watch({ adToken: token });
      now += 24 * 3600 * 1000; // clear the interval gate so the duplicate check is what rejects
      const { sent } = await watch({ adToken: token });
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.message).toBe('duplicate adToken');
      expect(comm.bal(accountId)).toBe(ADS_REWARD_COINS);
    });

    it('a second watch before the cooldown elapses -> 429, no second credit', async () => {
      await watch({ adToken: `tok-${randomUUID()}` });
      const { sent } = await watch({ adToken: `tok-${randomUUID()}` });
      expect(sent?.code).toBe(429);
      expect(sent?.payload.error?.message).toBe('ad cooldown not elapsed');
      expect(comm.bal(accountId)).toBe(ADS_REWARD_COINS);
    });

    it('past the daily cap -> 429 with a distinct reason, and the wallet stops growing', async () => {
      for (let i = 0; i < ADS_DAILY_CAP; i++) {
        now += ADS_MIN_INTERVAL_MS + 1000;
        const { sent } = await watch({ adToken: `cap-${i}-${randomUUID()}` });
        expect(sent).toBeUndefined();
      }
      now += ADS_MIN_INTERVAL_MS + 1000;
      const { sent } = await watch({ adToken: `cap-over-${randomUUID()}` });
      expect(sent?.code).toBe(429);
      expect(sent?.payload.error?.message).toBe('daily ad cap reached');
      expect(comm.bal(accountId)).toBe(ADS_DAILY_CAP * ADS_REWARD_COINS);
    });

    it('commercial refuses the credit -> 400, and the wallet stays where it was', async () => {
      comm.nextAdsCreditError = 'ADS_DAILY_LIMIT';
      const { sent } = await watch({ adToken: `tok-${randomUUID()}` });
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.message).toBe('ADS_DAILY_LIMIT');
      expect(comm.bal(accountId)).toBe(0);
    });
  });

  // ── adsPromo.ts: iapVerifyHandler ──────────────────────────────────────────────────────────────
  describe('iapVerifyHandler', () => {
    const verify = (body: unknown, c = core) => {
      const { reply, get } = mkReply();
      return iapVerifyHandler(c, mkReq(accountId, body), reply).then((out) => ({ out, sent: get() }));
    };

    it('commercial not configured -> 503', async () => {
      const { sent } = await verify({ platform: 'web', receipt: 'r' }, downCore());
      expect(sent?.code).toBe(503);
    });

    it('missing platform -> 400; missing receipt -> 400 (both halves of the guard)', async () => {
      expect((await verify({ receipt: 'r' })).sent?.code).toBe(400);
      expect((await verify({ platform: 'web' })).sent?.code).toBe(400);
    });

    it('happy path mirrors the granted coins into the save', async () => {
      const { out, sent } = await verify({ platform: 'web', receipt: 'tier:t499' });
      expect(sent).toBeUndefined();
      expect(data(out).granted).toBe(550);
      expect((data(out).save as unknown as SaveData).wallet.coins).toBe(550);
    });

    it('INVALID_RECEIPT keeps its own error code; any other reason degrades to BAD_REQUEST', async () => {
      comm.nextRechargeVerifyError = 'INVALID_RECEIPT';
      const bad = await verify({ platform: 'web', receipt: 'junk' });
      expect(bad.sent?.code).toBe(400);
      expect(bad.sent?.payload.error?.code).toBe('INVALID_RECEIPT');
      comm.nextRechargeVerifyError = 'STORE_UNREACHABLE';
      const other = await verify({ platform: 'web', receipt: 'junk' });
      expect(other.sent?.payload.error?.code).toBe('BAD_REQUEST');
      expect(other.sent?.payload.error?.message).toBe('STORE_UNREACHABLE');
      expect(comm.bal(accountId)).toBe(0);
    });
  });

  // ── adsPromo.ts: redeemPromoCodeHandler ────────────────────────────────────────────────────────
  describe('redeemPromoCodeHandler', () => {
    const redeem = (body: unknown, c = core) => {
      const { reply, get } = mkReply();
      return redeemPromoCodeHandler(c, mkReq(accountId, body), reply).then((out) => ({ out, sent: get() }));
    };

    it('commercial not configured -> 503', async () => {
      const { sent } = await redeem({ code: 'X' }, downCore());
      expect(sent?.code).toBe(503);
    });

    it('missing code -> 400', async () => {
      expect((await redeem({})).sent?.code).toBe(400);
    });

    it('a non-string code -> 400 rather than being forwarded to commercial as-is', async () => {
      // Only reachable by calling the handler directly; the route schema types `code` as a string.
      const { sent } = await redeem({ code: 12345 });
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.message).toBe('code required');
      expect(comm.bal(accountId)).toBe(0);
    });

    it('each mapped rejection keeps its documented HTTP status', async () => {
      for (const [error, code] of [
        ['PROMO_NOT_FOUND', 404], ['PROMO_EXPIRED', 400], ['PROMO_EXHAUSTED', 400], ['PROMO_ALREADY_USED', 400],
      ] as const) {
        comm.nextPromoError = error;
        const { sent } = await redeem({ code: 'WELCOME' });
        expect(sent?.code).toBe(code);
        expect(sent?.payload.error?.message).toBe(error);
      }
    });

    it('an unmapped rejection falls back to 400 instead of leaking a 200 or a 500', async () => {
      comm.nextPromoError = 'PROMO_REGION_LOCKED';
      const { sent } = await redeem({ code: 'WELCOME' });
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.message).toBe('PROMO_REGION_LOCKED');
      expect(comm.bal(accountId)).toBe(0);
    });

    it('happy path credits the coins and mirrors the balance', async () => {
      const { out, sent } = await redeem({ code: 'WELCOME' });
      expect(sent).toBeUndefined();
      expect(data(out).coinsGranted).toBe(100);
      expect((data(out).save as unknown as SaveData).wallet.coins).toBe(100);
    });
  });
});
