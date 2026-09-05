// Achievement endpoint end-to-end (S9-4): real Mongo + injected fake commercial. Stats are seeded directly into saves
// (PvE/PvP accumulation in S9-3/S9-6), verifying GET /achievements + claim double-validation + idempotent coin grant + concurrent dedup.
// Requires `cd server && docker compose up -d` and a prior `tsc -b` (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { CommercialClient, UndeliveredOrder } from '../dist/commercialClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_ach_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[achievements.e2e] Mongo unreachable (${URI}) — skipping.`);

/** Minimal fake commercial: wallet credit (grant idempotent by orderId) + getWallet; remaining endpoints are unreachable from claim paths — stubbed for TS. */
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
  grantCalls = 0;
  bal(id: string) {
    return this.coins.get(id) ?? 0;
  }
  async getWallet(id: string) {
    return { coins: this.bal(id), pity: {}, fatePoints: 0, subscriptionExpiry: 0, starterUsed: [], firstPurchaseUsed: false, totalRechargeCents: 0 };
  }
  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    this.grantCalls++;
    if (this.granted.has(a.orderId)) return { ok: true as const, coinsAfter: this.bal(a.accountId) };
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    this.granted.add(a.orderId);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async undeliveredOrders(): Promise<UndeliveredOrder[]> {
    return [];
  }
  // —— the following claim paths are never reached; stubs for TS type satisfaction ——
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
  // CommercialClient members this suite never exercises. They throw rather than answer: each was
  // simply absent before test/** was type-checked, so any call already crashed — this keeps that
  // truth while naming what happened.
  async createCustomPool(): Promise<never> { throw new Error('FakeCommercial.createCustomPool is not stubbed in this test'); }
  async closeLimitedPool(): Promise<never> { throw new Error('FakeCommercial.closeLimitedPool is not stubbed in this test'); }
  async listLimitedPools(): Promise<never> { throw new Error('FakeCommercial.listLimitedPools is not stubbed in this test'); }
  async listActiveLimitedPools(): Promise<never> { throw new Error('FakeCommercial.listActiveLimitedPools is not stubbed in this test'); }
  async redeemFate(): Promise<never> { throw new Error('FakeCommercial.redeemFate is not stubbed in this test'); }
  async monthlyCardBuy(): Promise<never> { throw new Error('FakeCommercial.monthlyCardBuy is not stubbed in this test'); }
  async yearCardBuy(): Promise<never> { throw new Error('FakeCommercial.yearCardBuy is not stubbed in this test'); }
  async monthlyCardClaim(): Promise<never> { throw new Error('FakeCommercial.monthlyCardClaim is not stubbed in this test'); }
  async starterBuy(): Promise<never> { throw new Error('FakeCommercial.starterBuy is not stubbed in this test'); }
  async verifyNonCoinReceipt(): Promise<never> { throw new Error('FakeCommercial.verifyNonCoinReceipt is not stubbed in this test'); }
  async promoRedeem(): Promise<never> { throw new Error('FakeCommercial.promoRedeem is not stubbed in this test'); }
  async createPromoCode(): Promise<never> { throw new Error('FakeCommercial.createPromoCode is not stubbed in this test'); }
  async listPromoCodes(): Promise<never> { throw new Error('FakeCommercial.listPromoCodes is not stubbed in this test'); }
  async paddleComplete(): Promise<never> { throw new Error('FakeCommercial.paddleComplete is not stubbed in this test'); }
  async paddleRefund(): Promise<never> { throw new Error('FakeCommercial.paddleRefund is not stubbed in this test'); }
  async recordPaddleEvent(): Promise<never> { throw new Error('FakeCommercial.recordPaddleEvent is not stubbed in this test'); }
  async listPaddleEvents(): Promise<never> { throw new Error('FakeCommercial.listPaddleEvents is not stubbed in this test'); }
  async auditCoinGains(): Promise<never> { throw new Error('FakeCommercial.auditCoinGains is not stubbed in this test'); }
}

describe.skipIf(!mongo)('meta achievements e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const claim = (achId: string, tier: number) =>
    app.inject({ method: 'POST', url: '/achievements/claim', headers: auth(), payload: { achId, tier } });
  /** Seed lifetime stats directly (bypassing PvE/PvP accumulation — S9-3/6 not yet implemented). */
  const seedStats = (stats: Record<string, number>) =>
    m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.stats': stats } });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    comm = new FakeCommercial();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: comm });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'dev-ach-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // initialize save record
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  it('GET /achievements: returns definition table + my stats + claimed progress', async () => {
    await seedStats({ 'kill.archer': 120 });
    const r = body(await app.inject({ method: 'GET', url: '/achievements', headers: auth() }));
    expect(r.ok).toBe(true);
    expect(r.data.defs.length).toBe(5);
    expect(r.data.stats['kill.archer']).toBe(120);
    expect(r.data.achievements).toEqual({});
  });

  it('claim below threshold → 400 + no coins granted', async () => {
    await seedStats({ 'kill.archer': 50 });
    const r = await claim('ach.kill.archer', 1);
    expect(r.statusCode).toBe(400);
    expect(comm.bal(accountId)).toBe(0);
  });

  it('claim at threshold → grants tier coins + records claimedTiers', async () => {
    await seedStats({ 'kill.archer': 120 });
    const r = body(await claim('ach.kill.archer', 1));
    expect(r.data.granted).toBe(50);
    expect(r.data.save.wallet.coins).toBe(50);
    expect(r.data.save.achievements['ach.kill.archer'].claimedTiers).toEqual([1]);
  });

  it('duplicate claim same tier → 409 ALREADY_CLAIMED, coins granted only once', async () => {
    await seedStats({ 'kill.archer': 120 });
    await claim('ach.kill.archer', 1);
    const dup = await claim('ach.kill.archer', 1);
    expect(dup.statusCode).toBe(409);
    expect(body(dup).error.code).toBe('ALREADY_CLAIMED');
    expect(comm.bal(accountId)).toBe(50); // still only 50
  });

  it('concurrent double-claim same tier → exactly one granted, one rejected', async () => {
    await seedStats({ 'kill.archer': 120 });
    const [a, b] = await Promise.all([claim('ach.kill.archer', 1), claim('ach.kill.archer', 1)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(comm.bal(accountId)).toBe(50);
  });

  it('unknown achievement / out-of-range tier → 400', async () => {
    expect((await claim('ach.nope', 1)).statusCode).toBe(400);
    await seedStats({ 'kill.archer': 9999 });
    expect((await claim('ach.kill.archer', 9)).statusCode).toBe(400);
  });

  it('multi-tier sequential claim: coins from tier I accumulate when claiming tier II', async () => {
    await seedStats({ 'kill.archer': 600 }); // reaches tier I(100) + II(500)
    await claim('ach.kill.archer', 1);
    const r2 = body(await claim('ach.kill.archer', 2));
    expect(r2.data.granted).toBe(100);
    expect(comm.bal(accountId)).toBe(150);
    expect(r2.data.save.achievements['ach.kill.archer'].claimedTiers.sort()).toEqual([1, 2]);
  });

  it('red line (A9 / A3): claim only changes coins, never touches ELO/rank/equipment/materials/PvE progress', async () => {
    await seedStats({ 'kill.archer': 120 });
    const before = body(await app.inject({ method: 'GET', url: '/save', headers: auth() })).data.save;
    const r = body(await claim('ach.kill.archer', 1));
    const after = r.data.save;
    // Only change is wallet coins (+50).
    expect(after.wallet.coins).toBe(before.wallet.coins + 50);
    // Combat/competitive fields must remain unchanged (achievements grant no power, META_DESIGN §11 red line).
    expect(after.pvp).toEqual(before.pvp); // elo/rank/wins/losses/streak…
    expect(after.equipped).toEqual(before.equipped);
    expect(after.materials ?? {}).toEqual(before.materials ?? {});
    expect(after.pveUpgrades ?? {}).toEqual(before.pveUpgrades ?? {});
    expect(after.progress).toEqual(before.progress);
    // Lifetime stats must not change on claim (claim only updates claimedTiers; stats are accumulated by settlement).
    expect(after.stats).toEqual(before.stats);
  });
});
