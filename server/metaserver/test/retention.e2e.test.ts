// Retention endpoint end-to-end tests (B5): real Mongo + injected fake commercial. Verifies that fields in
// defs.rewards / defs.tasks (kind/count, id/points) in the GET /retention response are **not stripped**
// after fastify-openapi-glue serialization — regression test for the 2026-06-24 check-in calendar `+undefined` bug (RETENTION_DESIGN §10.1).
// Requires `cd server && docker compose up -d` + prior `tsc -b` (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, makeMonthKey, makeWeekKey, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { CommercialClient, UndeliveredOrder } from '../dist/commercialClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_retention_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[retention.e2e] Mongo unreachable (${URI}) — skipping.`);

/** Minimal fake commercial: getWallet + idempotent grant; other claim paths are not reached, stubbed out. */
class FakeCommercial implements CommercialClient {
  readonly available = true;
  coins = new Map<string, number>();
  granted = new Set<string>();
  bal(id: string) {
    return this.coins.get(id) ?? 0;
  }
  async getWallet(id: string) {
    return { coins: this.bal(id), pity: {} };
  }
  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    if (this.granted.has(a.orderId)) return { ok: true as const, coinsAfter: this.bal(a.accountId) };
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    this.granted.add(a.orderId);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async undeliveredOrders(): Promise<UndeliveredOrder[]> {
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
}

describe.skipIf(!mongo)('meta retention e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  // Fixed to a 31-day month so 30 sequential daily claims never roll into the next monthKey.
  let fakeNow = new Date('2026-01-01T12:00:00Z').getTime();

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    fakeNow = new Date('2026-01-01T12:00:00Z').getTime();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: new FakeCommercial(), now: () => fakeNow });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'dev-ret-1' } }));
    token = r.data.token;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // create save record
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  it('GET /retention: defs.rewards / defs.tasks fields preserved after serialization (not stripped to {})', async () => {
    const r = body(await app.inject({ method: 'GET', url: '/retention', headers: auth() }));
    expect(r.ok).toBe(true);

    // —— Core regression assertions: fields must exist and be the correct type ——
    expect(Array.isArray(r.data.defs.rewards)).toBe(true);
    expect(r.data.defs.rewards.length).toBe(30);
    // Slot 1 = material drip; slot 7 (index 6) = milestone material pack + bonus coins (RETENTION_DESIGN §2.1, R1b).
    expect(r.data.defs.rewards[0]).toMatchObject({ kind: 'material', count: 3, id: 'scrap' });
    expect(r.data.defs.rewards[6]).toMatchObject({ kind: 'material', count: 5, id: 'lead', bonusCoins: 30 });
    // Each slot has kind + count (when stripped, count becomes undefined → client displays +undefined).
    for (const rw of r.data.defs.rewards) {
      expect(typeof rw.kind).toBe('string');
      expect(typeof rw.count).toBe('number');
    }

    expect(Array.isArray(r.data.defs.tasks)).toBe(true);
    expect(r.data.defs.tasks.length).toBeGreaterThan(0);
    for (const tk of r.data.defs.tasks) {
      expect(typeof tk.id).toBe('string');
      expect(typeof tk.points).toBe('number');
    }

    expect(typeof r.data.defs.pointsThreshold).toBe('number');
    expect(typeof r.data.defs.dailyCoinsReward).toBe('number');
    expect(r.data.claimable).toHaveProperty('checkin');
    expect(r.data.claimable).toHaveProperty('daily');
  });

  it('POST /retention/checkin: material reward (day 4) lands in save.materials, not inventory.skins (regular days are materials-only since 2026-08-01, R1b)', async () => {
    for (let day = 1; day <= 3; day++) {
      await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() });
      fakeNow += 25 * 3600 * 1000;
    }
    const r = body(await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
    expect(r.data.day).toBe(4);
    expect(r.data.reward).toMatchObject({ kind: 'material', id: 'scrap', count: 3 });
    // Days 1/2/4 = scrap x3 each (9 total), day 3 = lead x2 — matches CHECKIN_REWARDS[0..3].
    expect(r.data.save.materials.scrap).toBe(9);
    expect(r.data.save.materials.lead).toBe(2);
    expect(r.data.save.inventory.skins).not.toContain('scrap');
  });

  it('POST /retention/checkin: day-14 card milestone lands in save.cardInv, day-30 equipment milestone lands in save.equipmentInv (regression class — same "wrong bucket" bug fixed in gachaDraw/shopBuy)', async () => {
    let last: ReturnType<typeof body> | undefined;
    let expectedCoins = 0;
    for (let day = 1; day <= 30; day++) {
      // day-14's card milestone can draw a defId the account already has (e.g. one of the 3 onboarding
      // starters) — snapshot pre-existing card ids so the provenance check below targets the newly
      // granted instance specifically, not an unrelated pre-existing card that happens to share a defId.
      const prevCardIds = day === 14 ? new Set(Object.keys(last?.data.save.cardInv ?? {})) : undefined;
      last = body(await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
      expect(last.ok).toBe(true);
      expect(last.data.day).toBe(day);
      if (day === 14) {
        expect(last.data.reward.kind).toBe('card');
        expect(typeof last.data.reward.id).toBe('string');
        const cards: Array<{ id: string; defId: string; sourceType?: string; obtainedAt?: number }> = Object.values(last.data.save.cardInv ?? {});
        const granted = cards.find((c) => c.defId === last!.data.reward.id && !prevCardIds!.has(c.id));
        expect(granted).toBeDefined();
        expect(last.data.save.inventory.skins).not.toContain(last.data.reward.id);
        // Provenance (ITEM_IDENTITY_DESIGN.md, 2026-08-04): checkin card grants are tagged
        // `checkin:<monthKey>` with the grant timestamp — fixedNow keeps the whole run inside January.
        expect(granted!.sourceType).toBe(`checkin:${makeMonthKey(fakeNow)}`);
        expect(granted!.obtainedAt).toBe(fakeNow);
      }
      if (day === 30) {
        expect(last.data.reward.kind).toBe('equipment');
        expect(typeof last.data.reward.id).toBe('string');
        const equips: Array<{ defId: string; sourceType?: string; obtainedAt?: number }> = Object.values(last.data.save.equipmentInv ?? {});
        const granted = equips.find((e) => e.defId === last!.data.reward.id);
        expect(granted).toBeDefined();
        expect(last.data.save.inventory.skins).not.toContain(last.data.reward.id);
        expect(granted!.sourceType).toBe(`checkin:${makeMonthKey(fakeNow)}`);
        expect(granted!.obtainedAt).toBe(fakeNow);
      }
      // Milestone bonusCoins (R1b, 2026-08-01): delivered to save.wallet.coins independently of
      // the primary reward's own delivery path (material/card/equipment).
      if ([7, 14, 21, 30].includes(day)) {
        expect(last.data.reward.bonusCoins).toBeGreaterThan(0);
        expectedCoins += last.data.reward.bonusCoins;
        expect(last.data.save.wallet.coins).toBe(expectedCoins);
      } else {
        expect(last.data.reward.bonusCoins).toBeUndefined();
      }
      fakeNow += 25 * 3600 * 1000; // advance to the next calendar day, still inside January
    }
    expect(expectedCoins).toBe(200);
  });

  it('POST /retention/checkin: same day twice → 409 ALREADY_CLAIMED', async () => {
    await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() });
    const r = await app.inject({ method: 'POST', url: '/retention/checkin', headers: auth() });
    expect(r.statusCode).toBe(409);
  });

  // ── weekly active chest (§12.3) ──────────────────────────────────────────────────────────

  describe('weekly active chest', () => {
    /** Completes all DAILY_TASKS once (via /save/pve-clear-like settlement points not exposed
     * here — retention.ts's accrueRetentionTask is only reachable from inside metaserver, so
     * these tests drive it the same way the real settlement points do: directly write a save
     * with weekly points pre-set, using the internal /save PUT is unavailable for server-owned
     * fields — instead reuse the checkin endpoint's underlying mutateSave indirectly is not
     * possible either, so we seed retention.weekly directly through the collection.
     */
    async function seedWeeklyPoints(points: number, claimedTiers: number[] = []): Promise<void> {
      const doc = await m.collections.saves.findOne({});
      const accountId = doc!._id;
      // Must use the *real* week key for fakeNow — resetStaleRetention (called at the top of every
      // retention handler) wipes retention.weekly as stale the moment weekKey doesn't match makeWeekKey(now()).
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.retention.weekly': { weekKey: makeWeekKey(fakeNow), points, claimedTiers }, rev: doc!.rev + 1 } },
      );
    }

    it('GET /retention: weekly defs/claimable fields are present and not stripped by serialization', async () => {
      const r = body(await app.inject({ method: 'GET', url: '/retention', headers: auth() }));
      expect(r.ok).toBe(true);
      expect(Array.isArray(r.data.defs.weeklyChestTiers)).toBe(true);
      expect(r.data.defs.weeklyChestTiers.length).toBe(3);
      for (const tier of r.data.defs.weeklyChestTiers) {
        expect(typeof tier.threshold).toBe('number');
        expect(typeof tier.reward.kind).toBe('string');
        expect(typeof tier.reward.count).toBe('number');
      }
      expect(r.data.weekly).toBeNull(); // nothing accrued yet
      expect(r.data.claimable.weeklyTiers).toEqual([]);
    });

    it('POST /retention/weekly/claim: rejects before the threshold is reached', async () => {
      const r = await app.inject({
        method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 9 },
      });
      expect(r.statusCode).toBe(400);
    });

    it('POST /retention/weekly/claim: rejects an unknown threshold', async () => {
      await seedWeeklyPoints(21);
      const r = await app.inject({
        method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 999 },
      });
      expect(r.statusCode).toBe(400);
    });

    it('tier 1 (material): reward lands in save.materials, mirrors the checkin material-slot delivery', async () => {
      await seedWeeklyPoints(9);
      const r = body(await app.inject({
        method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 9 },
      }));
      expect(r.ok).toBe(true);
      expect(r.data.threshold).toBe(9);
      expect(r.data.reward).toMatchObject({ kind: 'material', id: 'lead', count: 20 });
      expect(r.data.save.materials.lead).toBeGreaterThanOrEqual(20);
    });

    it('tier 2 (equipment): reward lands in save.equipmentInv as an entry-tier (equip_t1) item', async () => {
      await seedWeeklyPoints(15);
      const r = body(await app.inject({
        method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 15 },
      }));
      expect(r.ok).toBe(true);
      expect(r.data.reward.kind).toBe('equipment');
      expect(typeof r.data.reward.id).toBe('string');
      const equips: Array<{ defId: string; sourceType?: string }> = Object.values(r.data.save.equipmentInv ?? {});
      const granted = equips.find((e) => e.defId === r.data.reward.id);
      expect(granted).toBeDefined();
      expect(granted!.sourceType).toBe(`weekly_chest:${makeWeekKey(fakeNow)}`);
    });

    it('tier 3 (skin): reward lands in save.inventory.skins, drawn from the shop-tier pool only', async () => {
      await seedWeeklyPoints(21);
      const r = body(await app.inject({
        method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 21 },
      }));
      expect(r.ok).toBe(true);
      expect(r.data.reward.kind).toBe('skin');
      expect(['skin_shop_c1', 'skin_shop_r1']).toContain(r.data.reward.id);
      expect(r.data.save.inventory.skins).toContain(r.data.reward.id);
    });

    it('all three tiers are independently claimable within the same week', async () => {
      await seedWeeklyPoints(21);
      for (const threshold of [9, 15, 21]) {
        const r = body(await app.inject({
          method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold },
        }));
        expect(r.ok).toBe(true);
        expect(r.data.threshold).toBe(threshold);
      }
    });

    it('rejects a repeat claim of the same tier → 409 ALREADY_CLAIMED', async () => {
      await seedWeeklyPoints(9);
      await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 9 } });
      const r = await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 9 } });
      expect(r.statusCode).toBe(409);
    });

    it('GET /retention reflects claimed tiers as no longer claimable', async () => {
      await seedWeeklyPoints(15);
      await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 9 } });
      const r = body(await app.inject({ method: 'GET', url: '/retention', headers: auth() }));
      expect(r.data.weekly.claimedTiers).toEqual([9]);
      expect(r.data.claimable.weeklyTiers).toEqual([15]);
    });
  });
});
