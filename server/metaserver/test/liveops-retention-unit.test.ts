// Unit-style coverage backfill for src/service/liveops/{retention,helpers}.ts (2026-08-14 coverage task).
// These handlers' happy-path business logic is already exercised end-to-end by test/retention.e2e.test.ts,
// but that file imports `buildApp` from '../dist/app.js' — vitest's v8 coverage provider only
// source-map-attributes execution of modules it itself loaded via its own transform, so running the
// *compiled* dist/*.js through Node's own ESM loader records zero coverage against the src/*.ts lines that
// actually ran. This file imports `buildApp` from '../src/app.js' instead (so the same request-level
// exercise gets attributed correctly) and adds the error/edge branches retention.e2e.test.ts's
// happy-path-oriented scenarios don't reach: MONTH_FULL-vs-ALREADY_CLAIMED_TODAY disambiguation, a
// material-tier weekly-chest ALREADY_CLAIMED (no recovery — settleWeeklyChestReward has nothing to do for
// 'material'), commercial.grant failing for a milestone's bonusCoins specifically, and deliverRetentionReward
// (helpers.ts)'s insert-race / already-committed-replay / non-11000-rethrow / grant-failure branches, called
// directly.
//
// Backed by test/helpers/fakeCollection.ts's FakeCollection (no real Mongo): every Mongo call reachable
// from these two files only ever uses findOne/findOneAndUpdate/updateOne with $set/$inc/upsert (grantCard/
// grantEquipment/mirrorCoins/recordMaterialGrants/grantTitleToPlayer) — never deliverGrant/deliverMailGrant's
// $addToSet-with-$each/$push-with-$each+$slice, which FakeCollection doesn't implement.
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeNewSave, makeWeekKey, makeMonthKey, makeDayKey, type Collections, type SaveData } from '@nw/shared';
// CommercialClient is metaserver's own interface, not a @nw/shared export.
import type { CommercialClient } from '../src/commercialClient';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { deliverRetentionReward, idemExpireAt } from '../src/service/liveops/helpers.js';
import type { ServiceDeps } from '../src/service/base.js';
import { FakeCollection } from './helpers/fakeCollection.js';

const jwt = { secret: 'test-secret' };

/** Mirrors retention.e2e.test.ts's FakeCommercial (idempotent grant by orderId), plus a `failNextOrderId`
 *  knob so individual tests can force one specific grant call to fail (drives the 502/retry-resilience
 *  branches without needing a real Mongo rev-race). */
class FakeCommercial implements CommercialClient {

  // Not exercised by this file — the Apple auto-renewal sync has its own suites
  // (commercial/test/appleSubscriptionSync.e2e.test.ts, metaserver/test/iapAppleSync.test.ts).
  // Present because CommercialClient requires it: a double that silently lacked a money-moving
  // method would let a handler regress to calling nothing at all and still look green.
  async subscriptionSyncApple(_a: { accountId: string; receipt: string }) {
    return { ok: true as const, coinsAfter: 0, subscriptionExpiry: 0, granted: 0 };
  }
  readonly available = true;
  coins = new Map<string, number>();
  granted = new Set<string>();
  failNextOrderId: string | null = null;
  bal(id: string) {
    return this.coins.get(id) ?? 0;
  }
  async getWallet(id: string) {
    return { coins: this.bal(id), pity: {}, fatePoints: 0, subscriptionExpiry: 0, starterUsed: [], firstPurchaseUsed: false, totalRechargeCents: 0 } as never;
  }
  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    if (this.failNextOrderId === a.orderId) {
      this.failNextOrderId = null;
      return { ok: false as const, error: 'injected failure' };
    }
    if (this.granted.has(a.orderId)) return { ok: true as const, coinsAfter: this.bal(a.accountId) };
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    this.granted.add(a.orderId);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async undeliveredOrders() {
    return [];
  }
  async shopCharge() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async gachaDraw() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async orderDelivered() {
    return { ok: true as const };
  }
  async rechargeVerify() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async adsCredit(a: { accountId: string; amount: number }) {
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async victoryCredit(a: { accountId: string; amount: number }) {
    return { ok: true as const, coinsAfter: this.bal(a.accountId), credited: a.amount, capped: false };
  }
  async spend(a: { accountId: string; amount: number }) {
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async listActiveLimitedPools() {
    return [] as never[];
  }
  async listLimitedPools() {
    return [] as never[];
  }
  async createCustomPool() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async closeLimitedPool() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async redeemFate() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async monthlyCardBuy() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async yearCardBuy() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async monthlyCardClaim() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async starterBuy() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async verifyNonCoinReceipt() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async promoRedeem() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async auditCoinGains() {
    return [];
  }
  async createPromoCode() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async listPromoCodes() {
    return [];
  }
  // Paddle surface added to CommercialClient later; this suite is retention check-ins only, so throw
  // rather than answer — an unexpected call should fail loudly, not look like a successful payment.
  async paddleComplete(): Promise<never> { throw new Error('FakeCommercial.paddleComplete is not stubbed'); }
  async paddleRefund(): Promise<never> { throw new Error('FakeCommercial.paddleRefund is not stubbed'); }
  async recordPaddleEvent(): Promise<never> { throw new Error('FakeCommercial.recordPaddleEvent is not stubbed'); }
  async listPaddleEvents(): Promise<never> { throw new Error('FakeCommercial.listPaddleEvents is not stubbed'); }
  // CommercialClient members this suite never exercises. They throw rather than answer: each was
  // simply absent before test/** was type-checked, so any call already crashed — this keeps that
  // truth while naming what happened.
}

interface FakeSaveDoc {
  _id: string;
  save: SaveData;
  rev: number;
}

function makeCols() {
  const saves = new FakeCollection<FakeSaveDoc>();
  const accounts = new FakeCollection<{ _id: string; [k: string]: unknown }>();
  const equipmentInstances = new FakeCollection<{ _id: string; accountId: string; [k: string]: unknown }>();
  const cardInstances = new FakeCollection<{ _id: string; accountId: string; [k: string]: unknown }>();
  const equipmentIdem = new FakeCollection<{ _id: string; accountId: string; op: string; result: unknown; committed: boolean; [k: string]: unknown }>();
  const materialInstances = new FakeCollection<{ _id: string; accountId: string; [k: string]: unknown }>();
  const pveStamina = new FakeCollection<{ _id: string; current: number; regenAt: number }>();
  const cols = { saves, accounts, equipmentInstances, cardInstances, equipmentIdem, materialInstances, pveStamina } as unknown as Collections;
  return { cols, saves, accounts, equipmentInstances, cardInstances, equipmentIdem, materialInstances, pveStamina };
}

/** Wraps a FakeCollection<{_id,save,rev}> `saves` handle so a specific field-changing write always loses
 *  its rev race — mirrors retention.e2e.test.ts's wrapFailingSaves technique for forcing a grant's own
 *  save-count-bump write to fail, without needing a real Mongo instance. */
function wrapFailingSaves(
  saves: FakeCollection<FakeSaveDoc>,
  isTargetWrite: (current: FakeSaveDoc, incoming: Partial<SaveData>) => boolean,
) {
  return {
    findOne: saves.findOne.bind(saves),
    updateOne: saves.updateOne.bind(saves),
    findOneAndUpdate: async (
      filter: Record<string, unknown>,
      update: Record<string, Record<string, unknown>>,
      opts?: { returnDocument?: 'before' | 'after' },
    ) => {
      const current = await saves.findOne(filter);
      const incoming = update.$set?.save as Partial<SaveData> | undefined;
      if (current && incoming && isTargetWrite(current, incoming)) return null;
      return saves.findOneAndUpdate(filter, update, opts);
    },
  };
}

describe('retention.ts + helpers.ts (src import, coverage backfill)', () => {
  let app: FastifyInstance;
  let cols: ReturnType<typeof makeCols>;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;
  let fakeNow = new Date('2026-01-01T12:00:00Z').getTime();

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  async function buildAndAuth(overrideCols?: Partial<Collections>): Promise<void> {
    comm = new FakeCommercial();
    fakeNow = new Date('2026-01-01T12:00:00Z').getTime();
    const mergedCols = overrideCols ? ({ ...cols.cols, ...overrideCols } as Collections) : cols.cols;
    app = await buildApp({ cols: mergedCols, jwt, internalKey: 'k', commercial: comm, authRateLimit: 0, now: () => fakeNow });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `device-${randomUUID()}` } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // initialize save record
  }

  beforeEach(async () => {
    cols = makeCols();
    await buildAndAuth();
  });

  // ── GET /retention ────────────────────────────────────────────────────────────────────────────
  describe('GET /retention', () => {
    it('fresh account: checkin/daily/weekly null, defs present, nothing claimable, ads status defaults', async () => {
      const r = body(await app.inject({ method: 'GET', url: '/retention', headers: auth() }));
      expect(r.ok).toBe(true);
      expect(r.data.checkin).toBeNull();
      expect(r.data.daily).toBeNull();
      expect(r.data.weekly).toBeNull();
      expect(r.data.defs.rewards.length).toBe(30);
      expect(r.data.claimable).toEqual({ checkin: true, daily: false, weeklyTiers: [] });
      expect(r.data.ads).toMatchObject({ watchedToday: 0, nextAvailableAt: 0 });
    });
  });

  // ── POST /retention/checkin ───────────────────────────────────────────────────────────────────
  describe('POST /retention/checkin', () => {
    it('happy path day 1: material reward lands in save.materials', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
      expect(r.ok).toBe(true);
      expect(r.data.day).toBe(1);
      expect(r.data.reward).toMatchObject({ kind: 'material', id: 'scrap', count: 3 });
      expect(r.data.save.materials.scrap).toBe(3);
    });

    it('day 14 card milestone + bonusCoins delivered', async () => {
      let last: ReturnType<typeof body> | undefined;
      for (let day = 1; day <= 14; day++) {
        last = body(await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
        fakeNow += 25 * 3600 * 1000;
      }
      expect(last!.data.day).toBe(14);
      expect(last!.data.reward.kind).toBe('card');
      expect(last!.data.reward.bonusCoins).toBe(40);
      expect(last!.data.save.wallet.coins).toBe(30 + 40); // day 7's 30 + day 14's 40
      const cards = Object.values(last!.data.save.cardInv ?? {}) as Array<{ defId: string }>;
      expect(cards.some((c) => c.defId === last!.data.reward.id)).toBe(true);
    });

    it('same day twice -> 409 ALREADY_CLAIMED (ALREADY_CLAIMED_TODAY branch)', async () => {
      await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() });
      const r = await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() });
      expect(r.statusCode).toBe(409);
      expect(body(r).error.message).toBe('already claimed today');
    });

    it('MONTH_FULL disambiguation: a retry on day 30 (same calendar day, claimedDays already 30) recovers the SAME item instead of erroring', async () => {
      let last: ReturnType<typeof body> | undefined;
      for (let day = 1; day <= 30; day++) {
        last = body(await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
        expect(last.ok).toBe(true);
        if (day < 30) fakeNow += 25 * 3600 * 1000;
      }
      expect(last!.data.day).toBe(30);
      expect(last!.data.reward.kind).toBe('equipment');
      const firstRewardId = last!.data.reward.id;
      const coinsAfterDay30 = last!.data.save.wallet.coins;

      // Same calendar day, no fakeNow advance: claimedDays.length is already 30 -> nextSlot=31 trips
      // MONTH_FULL (checked BEFORE lastClaimedDayKey) for what is really "already claimed today" —
      // the exact disambiguation the retention.ts comment describes. Recovery replays day 30's
      // already-delivered item + bonus exactly once (not a second grant).
      const retry = body(await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
      expect(retry.ok).toBe(true);
      expect(retry.data.day).toBe(30);
      expect(retry.data.reward.id).toBe(firstRewardId);
      expect(retry.data.save.wallet.coins).toBe(coinsAfterDay30); // bonus not re-delivered
      const equips = Object.values(retry.data.save.equipmentInv ?? {});
      expect(equips.length).toBe(1); // still exactly one, not a second re-rolled item
    });

    it('weekly chest equipment tier (15): a failed grantEquipment leaves the tier durably claimed but undelivered; retrying resumes delivering the SAME item exactly once', async () => {
      await seedWeeklyPoints(15);
      const failingApp = await buildApp({
        cols: { ...cols.cols, saves: wrapFailingSaves(cols.saves, (cur, inc) => inc.equipmentInvCount !== cur.save.equipmentInvCount) as never },
        jwt, internalKey: 'k', commercial: comm, now: () => fakeNow,
      });
      const failed = await failingApp.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 15 } });
      expect(failed.statusCode).toBe(502);
      await failingApp.close();

      const afterFailure = body(await app.inject({ method: 'GET', url: '/retention', headers: auth() }));
      expect(afterFailure.data.weekly.claimedTiers).toContain(15);

      const retried = body(await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 15 } }));
      expect(retried.ok).toBe(true);
      expect(retried.data.reward.kind).toBe('equipment');
      const equips = Object.values(retried.data.save.equipmentInv ?? {});
      expect(equips.length).toBe(1);

      const third = body(await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 15 } }));
      expect(third.ok).toBe(true);
      expect(third.data.reward.id).toBe(retried.data.reward.id);
    });

    it('checkin day-30 equipment milestone: a failed grantEquipment leaves the day durably claimed + bonus undelivered; retrying delivers the SAME item + bonus exactly once', async () => {
      const failingApp = await buildApp({
        cols: { ...cols.cols, saves: wrapFailingSaves(cols.saves, (cur, inc) => inc.equipmentInvCount !== cur.save.equipmentInvCount) as never },
        jwt, internalKey: 'k', commercial: comm, now: () => fakeNow,
      });
      let coinsBeforeDay30 = 0;
      for (let day = 1; day < 30; day++) {
        const r = body(await failingApp.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
        expect(r.ok).toBe(true);
        if (r.data.reward.bonusCoins) coinsBeforeDay30 += r.data.reward.bonusCoins;
        fakeNow += 25 * 3600 * 1000;
      }
      const failed = await failingApp.inject({ method: 'POST', url: '/retention/checkin', headers: auth() });
      expect(failed.statusCode).toBe(502);
      expect(coinsBeforeDay30).toBe(120); // 30+40+50 (days 7/14/21)

      const afterFailure = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(afterFailure.data.save.wallet.coins).toBe(coinsBeforeDay30); // day 30's bonus not yet delivered

      const retried = body(await failingApp.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
      expect(retried.ok).toBe(true);
      expect(retried.data.day).toBe(30);
      expect(retried.data.reward.bonusCoins).toBeGreaterThan(0);
      expect(retried.data.save.wallet.coins).toBe(coinsBeforeDay30 + retried.data.reward.bonusCoins);
      await failingApp.close();
    });

    it('milestone bonusCoins grant failure (day 7): 502, then a retry recovers via ALREADY_CLAIMED_TODAY and delivers the bonus exactly once', async () => {
      const orderId = `checkin:bonus:${accountId}:${makeMonthKey(fakeNow)}:7`;
      for (let day = 1; day < 7; day++) {
        await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() });
        fakeNow += 25 * 3600 * 1000;
      }
      comm.failNextOrderId = orderId;
      const failed = await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() });
      expect(failed.statusCode).toBe(502);

      const retried = body(await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
      expect(retried.ok).toBe(true);
      expect(retried.data.day).toBe(7);
      expect(retried.data.reward.bonusCoins).toBe(30);
      expect(retried.data.save.wallet.coins).toBe(30);

      // A third call replays the same balance, not double-crediting.
      const third = body(await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
      expect(third.data.save.wallet.coins).toBe(30);
    });
  });

  // ── POST /retention/daily/claim ───────────────────────────────────────────────────────────────
  describe('POST /retention/daily/claim', () => {
    it('no daily record at all (WRONG_DAY) -> 400 "no daily tasks completed today"', async () => {
      const r = await app.inject({ method: 'POST', url: '/retention/daily/claim', headers: auth() });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.message).toBe('no daily tasks completed today');
    });

    it('daily record exists but threshold not reached (NOT_REACHED) -> 400', async () => {
      await seedDaily(1, false);
      const r = await app.inject({ method: 'POST', url: '/retention/daily/claim', headers: auth() });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.message).toBe('task points not reached');
    });

    it('happy path: full points -> 5 coins granted, mirrored into save', async () => {
      await seedDaily(3, false);
      const r = body(await app.inject({ method: 'POST', url: '/retention/daily/claim', headers: auth() }));
      expect(r.ok).toBe(true);
      expect(r.data.coins).toBe(5);
      expect(r.data.save.wallet.coins).toBe(5);
    });

    it('commercial.grant fails on first claim -> 502; retry (ALREADY_CLAIMED recovery) re-attempts the SAME orderId and completes exactly once', async () => {
      await seedDaily(3, false);
      const orderId = `daily:${accountId}:${makeDayKey(fakeNow)}`;
      comm.failNextOrderId = orderId;
      const failed = await app.inject({ method: 'POST', url: '/retention/daily/claim', headers: auth() });
      expect(failed.statusCode).toBe(502);

      const afterFailure = body(await app.inject({ method: 'GET', url: '/retention', headers: auth() }));
      expect(afterFailure.data.daily.rewardClaimed).toBe(true); // durably marked even though coins never landed

      const retried = body(await app.inject({ method: 'POST', url: '/retention/daily/claim', headers: auth() }));
      expect(retried.ok).toBe(true);
      expect(retried.data.coins).toBe(5);
      expect(retried.data.save.wallet.coins).toBe(5);

      const third = body(await app.inject({ method: 'POST', url: '/retention/daily/claim', headers: auth() }));
      expect(third.data.save.wallet.coins).toBe(5); // not double-credited
    });
  });

  // ── POST /retention/weekly/claim ──────────────────────────────────────────────────────────────
  describe('POST /retention/weekly/claim', () => {
    it('rejects before the threshold is reached (NOT_REACHED) -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 9 } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.message).toBe('weekly points threshold not reached');
    });

    it('rejects an unknown threshold (BAD_REQUEST) -> 400', async () => {
      await seedWeeklyPoints(21);
      const r = await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 999 } });
      expect(r.statusCode).toBe(400);
      expect(body(r).error.message).toBe('unknown chest tier');
    });

    it('tier 1 (material): reward lands in save.materials', async () => {
      await seedWeeklyPoints(9);
      const r = body(await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 9 } }));
      expect(r.ok).toBe(true);
      expect(r.data.reward).toMatchObject({ kind: 'material', id: 'lead', count: 20 });
      expect(r.data.save.materials.lead).toBe(20);
    });

    it('tier 3 (card): reward lands in save.cardInv', async () => {
      await seedWeeklyPoints(21);
      const r = body(await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 21 } }));
      expect(r.ok).toBe(true);
      expect(r.data.reward.kind).toBe('card');
      const cards = Object.values(r.data.save.cardInv ?? {}) as Array<{ defId: string }>;
      expect(cards.some((c) => c.defId === r.data.reward.id)).toBe(true);
    });

    it('material tier repeat claim -> 409 ALREADY_CLAIMED, no recovery attempted (settleWeeklyChestReward has nothing to do for "material")', async () => {
      await seedWeeklyPoints(9);
      await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 9 } });
      const r = await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 9 } });
      expect(r.statusCode).toBe(409);
      expect(body(r).error.message).toBe('tier already claimed');
    });

    it('card tier (21): a failed grantCard leaves the tier durably claimed but undelivered; retrying resumes the SAME card exactly once', async () => {
      const before = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      const baselineIds = new Set(Object.keys(before.data.save.cardInv ?? {}));
      await seedWeeklyPoints(21);
      const failingApp = await buildApp({
        cols: { ...cols.cols, saves: wrapFailingSaves(cols.saves, (cur, inc) => inc.cardInvCount !== cur.save.cardInvCount) as never },
        jwt, internalKey: 'k', commercial: comm, now: () => fakeNow,
      });
      const failed = await failingApp.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 21 } });
      expect(failed.statusCode).toBe(502);
      await failingApp.close();

      const retried = body(await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 21 } }));
      expect(retried.ok).toBe(true);
      const newCards = Object.keys(retried.data.save.cardInv ?? {}).filter((id) => !baselineIds.has(id));
      expect(newCards.length).toBe(1);
    });
  });

  // ── helpers.ts direct unit coverage (deliverRetentionReward / idemExpireAt) ─────────────────────
  describe('helpers.ts direct unit coverage', () => {
    it('idemExpireAt: now + EQUIPMENT_IDEM_TTL_SEC (7 days)', () => {
      const now = 1_700_000_000_000;
      expect(idemExpireAt(now).getTime() - now).toBe(7 * 24 * 3600 * 1000);
    });

    function makeDeps(overrides: Partial<ServiceDeps['cols']> = {}): ServiceDeps {
      const fresh = makeCols();
      return { cols: { ...fresh.cols, ...overrides } as Collections, now: () => 1000 } as unknown as ServiceDeps;
    }

    it('fresh pick + successful grant: commits the idem ledger and returns deliveredId', async () => {
      const deps = makeDeps();
      // seed a save + wallet target account so grantEquipment can succeed
      await deps.cols.saves.updateOne(
        { _id: 'acc-helper-1' },
        { $setOnInsert: { _id: 'acc-helper-1', save: makeNewSave('acc-helper-1', 0), rev: 1 } },
        { upsert: true },
      );
      const r = await deliverRetentionReward(deps, 'acc-helper-1', 'order-1', 'checkin_reward', () => ({
        kind: 'equipment', defId: 'eq_def_1',
        instance: { id: 'inst-1', defId: 'eq_def_1', rarity: 'common', level: 0, affixes: [] },
      }));
      expect('deliveredId' in r).toBe(true);
      if ('deliveredId' in r) expect(r.deliveredId).toBe('eq_def_1');
      const idemDoc = await (deps.cols.equipmentIdem as unknown as FakeCollection<{ _id: string; committed: boolean }>).findOne({ _id: 'order-1' });
      expect(idemDoc?.committed).toBe(true);
    });

    it('already-committed replay: does not call the grant path again (no second DB write attempted)', async () => {
      const deps = makeDeps();
      const idem = deps.cols.equipmentIdem as unknown as FakeCollection<{ _id: string; accountId: string; op: string; result: unknown; committed: boolean }>;
      idem.seed({ _id: 'order-2', accountId: 'acc-x', op: 'checkin_reward', result: { kind: 'card', defId: 'card_1', instance: {} }, committed: true });
      const pick = () => { throw new Error('pick() must not be called on a committed replay'); };
      const r = await deliverRetentionReward(deps, 'acc-x', 'order-2', 'checkin_reward', pick as never);
      expect(r).toEqual({ deliveredId: 'card_1' });
    });

    it('insert race: a concurrent caller wins the insert (E11000) — the losing caller reads back and delivers THAT pick, not its own', async () => {
      const deps = makeDeps();
      const idem = deps.cols.equipmentIdem as unknown as FakeCollection<{ _id: string; accountId: string; op: string; result: unknown; committed: boolean }>;
      let insertAttempts = 0;
      const winningPick = { kind: 'equipment' as const, defId: 'eq_winner', instance: { id: 'inst-winner', defId: 'eq_winner', rarity: 'common' as const, level: 0, affixes: [] } };
      const raceIdem = {
        findOne: idem.findOne.bind(idem),
        updateOne: idem.updateOne.bind(idem),
        insertOne: async (doc: { _id: string; [k: string]: unknown }) => {
          insertAttempts++;
          // Simulate a concurrent winner landing the doc between our findOne and our insertOne.
          idem.seed({ _id: doc._id, accountId: doc.accountId as string, op: doc.op as string, result: winningPick, committed: false } as never);
          throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        },
      };
      await deps.cols.saves.updateOne(
        { _id: 'acc-race' },
        { $setOnInsert: { _id: 'acc-race', save: makeNewSave('acc-race', 0), rev: 1 } },
        { upsert: true },
      );
      const r = await deliverRetentionReward(
        { ...deps, cols: { ...deps.cols, equipmentIdem: raceIdem as never } } as ServiceDeps,
        'acc-race', 'order-race', 'checkin_reward',
        () => ({ kind: 'equipment', defId: 'eq_mine', instance: { id: 'inst-mine', defId: 'eq_mine', rarity: 'common', level: 0, affixes: [] } }),
      );
      expect(insertAttempts).toBe(1);
      expect('deliveredId' in r).toBe(true);
      if ('deliveredId' in r) expect(r.deliveredId).toBe('eq_winner'); // delivered the WINNER's pick, not ours
    });

    it('insert throws a non-11000 error: rethrown, not swallowed', async () => {
      const deps = makeDeps();
      const idem = deps.cols.equipmentIdem as unknown as FakeCollection<{ _id: string; [k: string]: unknown }>;
      const brokenIdem = {
        findOne: idem.findOne.bind(idem),
        updateOne: idem.updateOne.bind(idem),
        insertOne: async () => { throw new Error('disk full'); },
      };
      await expect(
        deliverRetentionReward(
          { ...deps, cols: { ...deps.cols, equipmentIdem: brokenIdem as never } } as ServiceDeps,
          'acc-y', 'order-3', 'checkin_reward',
          () => ({ kind: 'card', defId: 'card_2', instance: { id: 'inst-2', defId: 'card_2', level: 1, gear: {}, locked: false } }),
        ),
      ).rejects.toThrow('disk full');
    });

    it('grant fails (target account has no save document): returns the grant error, not a thrown exception', async () => {
      const deps = makeDeps(); // 'acc-nosave' never seeded into `saves`
      const r = await deliverRetentionReward(deps, 'acc-nosave', 'order-4', 'weekly_chest', () => ({
        kind: 'equipment', defId: 'eq_orphan', instance: { id: 'inst-orphan', defId: 'eq_orphan', rarity: 'common', level: 0, affixes: [] },
      }));
      expect('error' in r).toBe(true);
      if ('error' in r) expect(r.code).toBe('NOT_FOUND');
    });
  });

  // ── seeding helpers (mirrors retention.e2e.test.ts's direct-collection seeding — accrueRetentionTask
  //    is only reachable from inside metaserver's own settlement points, no HTTP endpoint exists for it) ──
  async function seedWeeklyPoints(points: number, claimedTiers: number[] = []): Promise<void> {
    const doc = await cols.saves.findOne({ _id: accountId });
    await cols.saves.updateOne(
      { _id: accountId },
      { $set: { 'save.retention.weekly': { weekKey: makeWeekKey(fakeNow), points, claimedTiers }, rev: doc!.rev + 1 } },
    );
  }

  async function seedDaily(taskPoints: number, rewardClaimed: boolean): Promise<void> {
    const doc = await cols.saves.findOne({ _id: accountId });
    await cols.saves.updateOne(
      { _id: accountId },
      {
        $set: {
          'save.retention.daily': {
            dayKey: makeDayKey(fakeNow),
            taskPoints,
            completedTasks: taskPoints >= 3 ? { 'pve.clear': 1, 'pvp.match': 1, 'gacha.draw': 1 } : { 'pve.clear': 1 },
            rewardClaimed,
          },
          rev: doc!.rev + 1,
        },
      },
    );
  }
});
