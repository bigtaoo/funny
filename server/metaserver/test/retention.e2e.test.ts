// Retention endpoint end-to-end tests (B5): real Mongo + injected fake commercial. Verifies that fields in
// defs.rewards / defs.tasks (kind/count, id/points) in the GET /retention response are **not stripped**
// after fastify-openapi-glue serialization — regression test for the 2026-06-24 check-in calendar `+undefined` bug (RETENTION_DESIGN §10.1).
// Requires `cd server && docker compose up -d` + prior `tsc -b` (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, makeDayKey, makeMonthKey, makeWeekKey, DAILY_COINS_REWARD, CARD_DEFS, type JwtConfig, type MongoHandle } from '@nw/shared';
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

  /** Completes all DAILY_TASKS once (via /save/pve-clear-like settlement points not exposed here —
   * retention.ts's accrueRetentionTask is only reachable from inside metaserver, so these tests
   * drive it the same way the real settlement points do: directly write a save with weekly points
   * pre-set, using the internal /save PUT is unavailable for server-owned fields — instead reuse the
   * checkin endpoint's underlying mutateSave indirectly is not possible either, so we seed
   * retention.weekly directly through the collection. Hoisted out of 'weekly active chest' below
   * (2026-08-05) so the delivery-resilience describe block can reuse it too. */
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

  describe('weekly active chest', () => {
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

    it('tier 3 (card): reward lands in save.cardInv as a legendary (Anna-faction) card only (2026-08-08: replaced the shop-skin reward)', async () => {
      await seedWeeklyPoints(21);
      const r = body(await app.inject({
        method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 21 },
      }));
      expect(r.ok).toBe(true);
      expect(r.data.reward.kind).toBe('card');
      expect(typeof r.data.reward.id).toBe('string');
      expect(CARD_DEFS[r.data.reward.id]?.faction).toBe('anna'); // legendary display rarity, see gachaCatalog.ts cardCatalog()
      const cards: Array<{ defId: string; sourceType?: string }> = Object.values(r.data.save.cardInv ?? {});
      const granted = cards.find((c) => c.defId === r.data.reward.id);
      expect(granted).toBeDefined();
      expect(granted!.sourceType).toBe(`weekly_chest:${makeWeekKey(fakeNow)}`);
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

  // ── delivery resilience (2026-08-05 fix) ────────────────────────────────────────────────────
  //
  // Root cause class (see liveops.ts deliverRetentionReward's doc comment): claimCheckin/
  // claimWeeklyChest mark the underlying claim durably BEFORE the equipment/card/coin grant call
  // runs. That ordering is correct and unchanged (it's the single race-free gate for concurrent
  // duplicate requests) — the bug was that a failed grant afterward used to be silently swallowed:
  // the claim stayed marked forever, the item was never delivered, and a retry just bounced off
  // ALREADY_CLAIMED before ever reaching the grant again. These tests force the grant's own
  // independent rev-guarded write to lose its race (same technique as pve.e2e.test.ts's "a failed
  // card-grant on /pve/clear" regression test) and verify the claim survives to a clean retry
  // instead of losing the reward.
  describe('retention delivery resilience (2026-08-05 fix)', () => {
    /** Wrap `saves.findOneAndUpdate` so a specific field-changing write always loses its rev race.
     * `isTargetWrite` compares the CURRENT doc against the incoming `$set.save` (mirrors
     * pve.e2e.test.ts's `incomingCardInvCount !== current.save.cardInvCount` check) — comparing
     * presence alone would also catch mutateSave's own claim-marking write, since equipmentInvCount
     * (unchanged) rides along on every full-save `$set` in this codebase, not just grant writes. */
    function wrapFailingSaves(isTargetWrite: (current: { save: Record<string, unknown> }, incoming: Record<string, unknown>) => boolean) {
      const realSaves = m.collections.saves;
      return {
        findOne: realSaves.findOne.bind(realSaves),
        findOneAndUpdate: async (
          filter: Parameters<typeof realSaves.findOneAndUpdate>[0],
          update: Parameters<typeof realSaves.findOneAndUpdate>[1],
          opts?: Parameters<typeof realSaves.findOneAndUpdate>[2],
        ) => {
          const current = await realSaves.findOne(filter as Record<string, unknown>);
          const incoming = (update as { $set?: { save?: Record<string, unknown> } }).$set?.save;
          if (current && incoming && isTargetWrite(current as unknown as { save: Record<string, unknown> }, incoming)) return null;
          return realSaves.findOneAndUpdate(filter, update, opts);
        },
      } as typeof realSaves;
    }
    const failsOnEquipmentGrant = () => wrapFailingSaves((current, incoming) =>
      incoming.equipmentInvCount !== (current.save as { equipmentInvCount: number }).equipmentInvCount);
    const failsOnCardGrant = () => wrapFailingSaves((current, incoming) =>
      incoming.cardInvCount !== (current.save as { cardInvCount: number }).cardInvCount); // mirrors pve.e2e.test.ts's isCardGrantWrite check

    it('weekly chest equipment tier (15): a failed grantEquipment leaves the tier durably claimed but undelivered; retrying resumes delivering the SAME item exactly once', async () => {
      await seedWeeklyPoints(15);
      const failingApp = await buildApp({ cols: { ...m.collections, saves: failsOnEquipmentGrant() }, jwt, internalKey: 'k', commercial: new FakeCommercial(), now: () => fakeNow });
      try {
        const failed = await failingApp.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 15 } });
        expect(failed.statusCode).toBe(502);
      } finally {
        await failingApp.close();
      }

      // Tier is durably marked claimed even though delivery failed. The equipment *instance* already
      // landed at this point — grantEquipment's equipmentInstances upsert runs unconditionally before
      // its own rev-guarded save.equipmentInvCount bump (equipment.ts, "ordering discipline, not
      // transactions" house style) — only that count mirror (a cheap, self-healing cap-check cache,
      // per equipmentInstances split's own docs) is what the forced failure actually hits. The real
      // gap this fix closes is the idem ledger's `committed` flag staying false, which is what the
      // retry below exercises: without it, nothing tells a later request "resume this exact item"
      // instead of losing track of it or re-rolling a different one.
      const afterFailure = body(await app.inject({ method: 'GET', url: '/retention', headers: auth() }));
      expect(afterFailure.data.weekly.claimedTiers).toContain(15);
      const saveAfterFailure = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(Object.keys(saveAfterFailure.data.save.equipmentInv ?? {}).length).toBe(1);

      // Retry (real app, grant no longer forced to fail): resumes delivering the exact item that was
      // picked and persisted to the idem ledger during the failed attempt, instead of re-rolling a
      // different one or losing the reward.
      const retried = body(await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 15 } }));
      expect(retried.ok).toBe(true);
      expect(retried.data.reward.kind).toBe('equipment');
      expect(typeof retried.data.reward.id).toBe('string');
      const equips = Object.values(retried.data.save.equipmentInv ?? {}) as Array<{ defId: string }>;
      expect(equips.length).toBe(1); // exactly one, not a second re-rolled item from the retry
      expect(equips[0].defId).toBe(retried.data.reward.id);

      // A third call replays the same already-delivered item (idem ledger `committed: true`) rather
      // than granting a second one or erroring.
      const third = body(await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 15 } }));
      expect(third.ok).toBe(true);
      expect(third.data.reward.id).toBe(retried.data.reward.id);
      expect(Object.keys(third.data.save.equipmentInv ?? {}).length).toBe(1);
    });

    it('weekly chest card tier (21): a failed grantCard leaves the tier durably claimed but undelivered; retrying resumes delivering the SAME card exactly once', async () => {
      // Baseline includes the account's 3 onboarding starter cards (auth.ts maybeGrantStarterCards)
      // — cardInv is never empty for a real save, so track ids relative to this baseline instead of
      // asserting raw counts, same technique as the day-14 checkin card milestone test above.
      const before = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      const baselineIds = new Set(Object.keys(before.data.save.cardInv ?? {}));

      await seedWeeklyPoints(21);
      const failingApp = await buildApp({ cols: { ...m.collections, saves: failsOnCardGrant() }, jwt, internalKey: 'k', commercial: new FakeCommercial(), now: () => fakeNow });
      try {
        const failed = await failingApp.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 21 } });
        expect(failed.statusCode).toBe(502);
      } finally {
        await failingApp.close();
      }

      // Tier is durably marked claimed even though delivery failed. The card *instance* already
      // landed at this point — grantCard's cardInstances upsert runs unconditionally before its own
      // rev-guarded save.cardInvCount bump (cards.ts, same "ordering discipline, not transactions"
      // house style as equipment.ts) — only that count mirror is what the forced failure actually
      // hits. The real gap this fix closes is the idem ledger's `committed` flag staying false,
      // which is what the retry below exercises: without it, nothing tells a later request "resume
      // this exact card" instead of losing track of it or re-rolling a different one.
      const saveAfterFailure = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      const newCardsAfterFailure = Object.keys(saveAfterFailure.data.save.cardInv ?? {}).filter((id) => !baselineIds.has(id));
      expect(newCardsAfterFailure.length).toBe(1); // already landed, just not yet marked committed

      const retried = body(await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 21 } }));
      expect(retried.ok).toBe(true);
      expect(retried.data.reward.kind).toBe('card');
      expect(CARD_DEFS[retried.data.reward.id]?.faction).toBe('anna');
      const newCards = Object.entries(retried.data.save.cardInv ?? {})
        .filter(([id]) => !baselineIds.has(id))
        .map(([, c]) => c as { defId: string });
      expect(newCards.length).toBe(1); // exactly one new card, not a second re-rolled one from the retry
      expect(newCards[0].defId).toBe(retried.data.reward.id);

      // A third call replays the same already-delivered card (idem ledger `committed: true`) rather
      // than granting a second one or erroring.
      const third = body(await app.inject({ method: 'POST', url: '/retention/weekly/claim', headers: auth(), payload: { threshold: 21 } }));
      expect(third.ok).toBe(true);
      expect(third.data.reward.id).toBe(retried.data.reward.id);
      const thirdNewCards = Object.keys(third.data.save.cardInv ?? {}).filter((id) => !baselineIds.has(id));
      expect(thirdNewCards.length).toBe(1); // still exactly one new card after a third replay
    });

    it('checkin day-30 equipment milestone: a failed grantEquipment leaves the day durably claimed but undelivered (bonusCoins too); retrying delivers the SAME item + the bonus exactly once', async () => {
      // Retries below reuse `failingApp` (not the outer `app` fixture) deliberately: the coin ledger
      // lives in FakeCommercial's in-memory Map, keyed per app instance — switching to a second app
      // with its own empty FakeCommercial would desync from the wallet.coins already mirrored into
      // Mongo by the days-1..29 grants above and make the bonus-coin bookkeeping below meaningless.
      // The equipment-write wrap itself stays perfectly safe to keep using: day 30's retry resolves
      // via grantEquipment's own idempotent-by-id shortcut (the instance already exists from the
      // failed attempt), which returns before ever touching the wrapped equipmentInvCount write.
      const failingApp = await buildApp({ cols: { ...m.collections, saves: failsOnEquipmentGrant() }, jwt, internalKey: 'k', commercial: new FakeCommercial(), now: () => fakeNow });
      let coinsBeforeDay30 = 0;
      try {
        for (let day = 1; day < 30; day++) {
          const r = body(await failingApp.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
          expect(r.ok).toBe(true); // days 1..29 never touch equipmentInvCount, unaffected by the wrap
          if (r.data.reward.bonusCoins) coinsBeforeDay30 += r.data.reward.bonusCoins; // days 7/14/21 milestones
          fakeNow += 25 * 3600 * 1000;
        }
        const failed = await failingApp.inject({ method: 'POST', url: '/retention/checkin', headers: auth() });
        expect(failed.statusCode).toBe(502); // day 30's equipment grant forced to fail
        expect(coinsBeforeDay30).toBe(120); // 30 + 40 + 50, sanity-checks the loop actually ran days 7/14/21

        // Same caveat as the weekly-chest equipment test above: the instance itself already landed
        // (grantEquipment's equipmentInstances upsert is unconditional, only its count-bump was forced
        // to fail) — bonusCoins, however, is gated entirely behind the equipment delivery succeeding
        // (settleCheckinReward returns early on error, never reaching the bonusCoins block), so day
        // 30's bonus specifically is genuinely undelivered here, not just a stale mirror.
        // A plain read: safe on the clean `app` (same underlying Mongo doc) — `failingApp`'s wrapped
        // `saves` stand-in only implements the two methods grantEquipment's retry actually needs.
        const afterFailure = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
        expect(Object.keys(afterFailure.data.save.equipmentInv ?? {}).length).toBe(1);
        expect(afterFailure.data.save.wallet.coins).toBe(coinsBeforeDay30); // day 30's bonus not yet delivered

        const retried = body(await failingApp.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
        expect(retried.ok).toBe(true);
        expect(retried.data.day).toBe(30);
        expect(retried.data.reward.kind).toBe('equipment');
        expect(retried.data.reward.bonusCoins).toBeGreaterThan(0);
        const equips = Object.values(retried.data.save.equipmentInv ?? {}) as Array<{ defId: string }>;
        expect(equips.length).toBe(1);
        expect(equips[0].defId).toBe(retried.data.reward.id);
        const expectedCoins = coinsBeforeDay30 + retried.data.reward.bonusCoins;
        expect(retried.data.save.wallet.coins).toBe(expectedCoins); // bonus delivered exactly once, not doubled by the retry

        const third = body(await failingApp.inject({ method: 'POST', url: '/retention/checkin', headers: auth() }));
        expect(third.ok).toBe(true);
        expect(third.data.reward.id).toBe(retried.data.reward.id);
        expect(third.data.save.wallet.coins).toBe(expectedCoins); // still exactly once
        expect(Object.keys(third.data.save.equipmentInv ?? {}).length).toBe(1);
      } finally {
        await failingApp.close();
      }
    });

    it('claimDailyReward: a failed commercial coin grant leaves rewardClaimed durably true; retrying re-attempts the SAME idempotent grant and credits exactly once', async () => {
      // Complete all daily tasks so the reward is claimable (drives accrueRetentionTask the same way
      // pve.clear/pvp/gacha would — no HTTP endpoint for it, so seed retention.daily directly). dayKey
      // must be the *real* day key for fakeNow — resetStaleRetention wipes it as stale otherwise.
      const doc = await m.collections.saves.findOne({});
      const accountId = doc!._id;
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.retention.daily': { dayKey: makeDayKey(fakeNow), taskPoints: 3, completedTasks: { 'pve.clear': 1, 'pvp.match': 1, 'gacha.draw': 1 }, rewardClaimed: false }, rev: doc!.rev + 1 } },
      );

      class FlakyCommercial extends FakeCommercial {
        fail = true;
        async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
          if (this.fail) return { ok: false as const, error: 'injected failure' };
          return super.grant(a);
        }
      }
      const flaky = new FlakyCommercial();
      const failingApp = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: flaky, now: () => fakeNow });
      try {
        const failed = await failingApp.inject({ method: 'POST', url: '/retention/daily/claim', headers: auth() });
        expect(failed.statusCode).toBe(502);
      } finally {
        await failingApp.close();
      }

      // rewardClaimed is durably true even though the coins were never credited.
      const afterFailure = body(await app.inject({ method: 'GET', url: '/retention', headers: auth() }));
      expect(afterFailure.data.daily.rewardClaimed).toBe(true);
      expect(afterFailure.data.save?.wallet?.coins ?? 0).toBe(0);

      // Retry against the SAME flaky commercial, now unblocked: ALREADY_CLAIMED recovery re-attempts
      // the identical deterministic orderId (commercial.grant is idempotent by orderId) and completes.
      flaky.fail = false;
      const retryApp = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: flaky, now: () => fakeNow });
      try {
        const retried = body(await retryApp.inject({ method: 'POST', url: '/retention/daily/claim', headers: auth() }));
        expect(retried.ok).toBe(true);
        expect(retried.data.coins).toBe(DAILY_COINS_REWARD);
        expect(retried.data.save.wallet.coins).toBe(DAILY_COINS_REWARD);

        // A third call replays the same credited balance instead of double-crediting.
        const third = body(await retryApp.inject({ method: 'POST', url: '/retention/daily/claim', headers: auth() }));
        expect(third.data.save.wallet.coins).toBe(DAILY_COINS_REWARD);
      } finally {
        await retryApp.close();
      }
    });
  });
});
