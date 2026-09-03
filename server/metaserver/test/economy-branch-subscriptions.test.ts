// Branch-coverage backfill for src/service/economy/subscriptions.ts (2026-09-03). The route-level suite
// (test/economy-service-unit.test.ts) covers the happy paths and the ALREADY_ACTIVE / not-reached
// refusals; what is left — and what this file adds — is every branch that decides whether a paying
// player's coins actually arrive:
//   * a subscription purchase whose wallet read fails afterwards (the mirror is skipped, but the
//     purchase must still be reported as successful — commercial already took the money),
//   * the recharge-milestone coin-grant reconciliation in each of its three failure shapes (grant
//     throws / grant refuses / commercial down), which exists precisely because the tier is marked
//     claimed *before* the coins are granted,
//   * the exhausted-optimistic-lock fallthrough (REV_CONFLICT), unreachable from a single HTTP caller.
// Handlers are called directly (see test/economy-branch-fakes.ts for why) against real Mongo (rs0,
// DB nw_meta_grpC_branch_test).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createMongo, makeNewSave, type Collections, type MongoHandle, type SaveData, RECHARGE_TIERS } from '@nw/shared';
import {
  monthlyCardBuyHandler, yearCardBuyHandler, monthlyCardClaimHandler, claimRechargeMilestoneHandler,
} from '../src/service/economy/subscriptions.js';
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
if (!mongo) console.warn(`[economy-branch-subscriptions] Mongo unreachable (${URI}) — skipping.`);

const TIER1 = RECHARGE_TIERS[0]!;
const TIER3 = RECHARGE_TIERS[2]!;

describe.skipIf(!mongo)('service/economy/subscriptions.ts branch backfill', () => {
  const m = mongo!;
  let accountId: string;
  let comm: BranchCommercial;
  let core: ReturnType<typeof makeCore>;

  const data = (r: unknown) => (r as { data: Record<string, never> }).data;
  const downCore = () => makeCore({ cols: m.collections, commercial: new BranchCommercial(false), now: () => NOW });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    accountId = `acc-${randomUUID()}`;
    comm = new BranchCommercial();
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

  // ── monthlyCardBuyHandler / yearCardBuyHandler ────────────────────────────────────────────────
  for (const card of [
    { name: 'monthly card', handler: monthlyCardBuyHandler, product: 'monthly_card' },
    { name: 'year card', handler: yearCardBuyHandler, product: 'year_card' },
  ] as const) {
    describe(`${card.name} purchase`, () => {
      it('commercial not configured -> 503, no receipt verification attempted', async () => {
        const { reply, get } = mkReply();
        await card.handler(downCore(), mkReq(accountId, { platform: 'dev', receipt: `product:${card.product}` }), reply);
        expect(get()?.code).toBe(503);
      });

      it('no request body at all -> 400 (the `req.body ?? {}` fallback, not a TypeError)', async () => {
        const { reply, get } = mkReply();
        await card.handler(core, mkReq(accountId, undefined), reply);
        expect(get()?.code).toBe(400);
        expect(get()?.payload.error?.message).toBe('missing platform/receipt');
      });

      it('platform supplied but receipt missing -> 400 (the second half of the guard)', async () => {
        const { reply, get } = mkReply();
        await card.handler(core, mkReq(accountId, { platform: 'ios' }), reply);
        expect(get()?.code).toBe(400);
      });

      it('receipt that does not resolve to this product -> 400 INVALID_RECEIPT, nothing purchased', async () => {
        const { reply, get } = mkReply();
        await card.handler(core, mkReq(accountId, { platform: 'ios', receipt: 'product:something_else' }), reply);
        expect(get()?.code).toBe(400);
        expect(get()?.payload.error?.code).toBe('INVALID_RECEIPT');
        expect(comm.subscriptionExpiry).toBe(0);
      });

      it('ALREADY_ACTIVE is surfaced with its own error code (the client shows "already subscribed")', async () => {
        comm.nextSubscriptionError = 'ALREADY_ACTIVE';
        const { reply, get } = mkReply();
        await card.handler(core, mkReq(accountId, { platform: 'ios', receipt: `product:${card.product}` }), reply);
        expect(get()?.code).toBe(400);
        expect(get()?.payload.error?.code).toBe('ALREADY_ACTIVE');
      });

      it('any other commercial refusal maps to BAD_REQUEST, keeping ALREADY_ACTIVE meaningful', async () => {
        comm.nextSubscriptionError = 'SUBSCRIPTION_LOCKED';
        const { reply, get } = mkReply();
        await card.handler(core, mkReq(accountId, { platform: 'ios', receipt: `product:${card.product}` }), reply);
        expect(get()?.code).toBe(400);
        expect(get()?.payload.error?.code).toBe('BAD_REQUEST');
        expect(get()?.payload.error?.message).toBe('SUBSCRIPTION_LOCKED');
      });

      it('purchase succeeds but the wallet read comes back empty -> still ok, mirror left for the next GET /save', async () => {
        // commercial has already charged the store receipt here; refusing would lose the purchase.
        comm.walletUnavailable = true;
        const { reply, get } = mkReply();
        const out = await card.handler(core, mkReq(accountId, { platform: 'ios', receipt: `product:${card.product}` }), reply);
        expect(get()).toBeUndefined();
        expect((data(out).save as unknown as SaveData).accountId).toBe(accountId);
        expect(comm.subscriptionExpiry).toBeGreaterThan(0);
      });

      it('wallet embedded in the purchase response -> mirrored without a second round trip', async () => {
        comm.populateWallet = true;
        const { reply } = mkReply();
        const out = await card.handler(core, mkReq(accountId, { platform: 'ios', receipt: `product:${card.product}` }, 'ios'), reply);
        expect((data(out).save as unknown as SaveData).monetization?.subscriptionExpiry).toBe(comm.subscriptionExpiry);
      });
    });
  }

  // ── monthlyCardClaimHandler ───────────────────────────────────────────────────────────────────
  describe('monthly card daily claim', () => {
    it('commercial not configured -> 503', async () => {
      const { reply, get } = mkReply();
      await monthlyCardClaimHandler(downCore(), mkReq(accountId), reply);
      expect(get()?.code).toBe(503);
    });

    it('commercial refuses (no active subscription) -> 400 carrying the raw reason', async () => {
      comm.nextSubscriptionError = 'NO_SUBSCRIPTION';
      const { reply, get } = mkReply();
      await monthlyCardClaimHandler(core, mkReq(accountId), reply);
      expect(get()?.code).toBe(400);
      expect(get()?.payload.error?.message).toBe('NO_SUBSCRIPTION');
    });

    it('claim lands but the wallet read fails -> the claimed amount is still reported', async () => {
      comm.walletUnavailable = true;
      const { reply, get } = mkReply();
      const out = await monthlyCardClaimHandler(core, mkReq(accountId), reply);
      expect(get()).toBeUndefined();
      expect(data(out).claimed).toBe(20);
      expect(comm.bal(accountId)).toBe(20);
    });

    it('happy path mirrors the fresh balance into the save', async () => {
      const { reply } = mkReply();
      const out = await monthlyCardClaimHandler(core, mkReq(accountId, undefined, 'wechat'), reply);
      expect((data(out).save as unknown as SaveData).wallet.coins).toBe(20);
    });
  });

  // ── claimRechargeMilestoneHandler ─────────────────────────────────────────────────────────────
  describe('recharge milestone claim', () => {
    const claim = (tierId: number, c = core) => {
      const { reply, get } = mkReply();
      return claimRechargeMilestoneHandler(c, mkReq(accountId, { tierId }), reply).then((out) => ({ out, sent: get() }));
    };

    it('commercial not configured -> 503', async () => {
      const { sent } = await claim(1, downCore());
      expect(sent?.code).toBe(503);
    });

    it('wallet unavailable -> 400 (progress is commercial-authoritative; claiming blind could over-grant)', async () => {
      comm.walletUnavailable = true;
      const { sent } = await claim(1);
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.message).toBe('wallet unavailable');
    });

    it('unknown tier -> 400 bad request', async () => {
      comm.totalRechargeCents = 1_000_000;
      const { sent } = await claim(9999);
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.message).toBe('bad request');
    });

    it('threshold not reached -> 400, nothing claimed and no coins granted', async () => {
      comm.totalRechargeCents = TIER1.thresholdCents - 1;
      const { sent } = await claim(TIER1.id);
      expect(sent?.code).toBe(400);
      expect(sent?.payload.error?.message).toBe('threshold not reached');
      expect(comm.grantCalls).toEqual([]);
    });

    it('happy path: coins granted under a deterministic orderId and mirrored into the save', async () => {
      comm.totalRechargeCents = TIER1.thresholdCents;
      const { out, sent } = await claim(TIER1.id);
      expect(sent).toBeUndefined();
      expect(comm.grantCalls).toEqual([{
        accountId, amount: 60, reason: 'recharge_milestone_claim', orderId: `recharge.claim.${accountId}.${TIER1.id}`,
      }]);
      expect((data(out).save as unknown as SaveData).wallet.coins).toBe(60);
    });

    it('mixed coin+material tier: materials land in the save and get a provenance row', async () => {
      comm.totalRechargeCents = TIER3.thresholdCents;
      const { out } = await claim(TIER3.id);
      const save = data(out).save as unknown as SaveData;
      expect(save.materials.lead).toBe(6);
      expect(await m.collections.materialInstances.countDocuments({ accountId })).toBeGreaterThan(0);
    });

    it('the coin grant throwing does not fail the claim (the tier stays claimed, coins retriable)', async () => {
      // Why this branch matters: the milestone is recorded irreversibly before the grant runs, so an
      // exception here must be swallowed — the deterministic orderId lets a later claim redeliver.
      comm.totalRechargeCents = TIER1.thresholdCents;
      comm.grantThrows = true;
      const { out, sent } = await claim(TIER1.id);
      expect(sent).toBeUndefined();
      expect((data(out).save as unknown as SaveData).wallet.coins).toBe(0); // coins owed, not lost
      const stored = (await m.collections.saves.findOne({ _id: accountId }))!.save;
      expect(stored.rechargeMilestone?.claimed).toContain(TIER1.id);
    });

    it('the coin grant being refused leaves the claim recorded and returns the un-mirrored save', async () => {
      comm.totalRechargeCents = TIER1.thresholdCents;
      comm.grantFails = true;
      const { out } = await claim(TIER1.id);
      expect((data(out).save as unknown as SaveData).wallet.coins).toBe(0);
      expect(comm.grantCalls).toHaveLength(1);
    });

    it('a second claim of the same tier -> 409, and retries the coin grant for it', async () => {
      comm.totalRechargeCents = TIER1.thresholdCents;
      comm.grantThrows = true;
      await claim(TIER1.id); // tier recorded, coins never delivered
      comm.grantThrows = false;
      const { sent } = await claim(TIER1.id);
      expect(sent?.code).toBe(409);
      expect(sent?.payload.error?.code).toBe('ALREADY_CLAIMED');
      // The reconciliation retry on the ALREADY_CLAIMED path actually delivered the owed coins.
      expect(comm.grantCalls).toEqual([{
        accountId, amount: 60, reason: 'recharge_milestone_claim', orderId: `recharge.claim.${accountId}.${TIER1.id}`,
      }]);
      expect(comm.bal(accountId)).toBe(60);
    });

    it('ALREADY_CLAIMED whose retry grant is refused again -> still 409, no coins, no crash', async () => {
      // The reconciliation has no `currentSave` to fall back on here (the mutateSave never produced
      // one), so it re-reads the save instead — the branch that would otherwise return undefined.
      comm.totalRechargeCents = TIER1.thresholdCents;
      comm.grantThrows = true;
      await claim(TIER1.id);
      comm.grantThrows = false;
      comm.grantFails = true;
      const { sent } = await claim(TIER1.id);
      expect(sent?.code).toBe(409);
      expect(comm.bal(accountId)).toBe(0);
      expect(comm.grantCalls).toHaveLength(1); // the refused retry
    });

    it('optimistic lock never wins -> 409 REV_CONFLICT (the default arm of the error switch)', async () => {
      // A single HTTP caller cannot exhaust mutateSave's four attempts; a collection whose CAS always
      // misses can. The claim must surface as a retryable conflict, never as a silent success.
      const realSaves = m.collections.saves;
      const cols: Collections = {
        ...m.collections,
        saves: {
          ...realSaves,
          findOne: realSaves.findOne.bind(realSaves),
          findOneAndUpdate: async () => null,
          updateOne: realSaves.updateOne.bind(realSaves),
        } as unknown as typeof realSaves,
      };
      comm.totalRechargeCents = TIER1.thresholdCents;
      const conflictCore = makeCore({ cols, commercial: comm, now: () => NOW });
      const { sent } = await claim(TIER1.id, conflictCore);
      expect(sent?.code).toBe(409);
      expect(sent?.payload.error?.code).toBe('REV_CONFLICT');
      expect(comm.grantCalls).toEqual([]); // no coins for a claim that never committed
    });
  });
});
