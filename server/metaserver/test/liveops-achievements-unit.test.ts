// Unit-style coverage backfill for src/service/liveops/achievements.ts (2026-08-14 coverage task).
// Happy-path business logic is already exercised end-to-end by test/achievements.e2e.test.ts, but that
// file imports `buildApp` from '../dist/app.js' — vitest's v8 coverage provider only source-map-attributes
// execution of modules it itself loaded via its own transform, so running the *compiled* dist/*.js through
// Node's own ESM loader records zero coverage against the src/*.ts lines that actually ran. This file
// imports `buildApp` from '../src/app.js' instead, backed by test/helpers/fakeCollection.ts's FakeCollection
// (no real Mongo — achievements.ts's only Mongo touch points are getOrCreateSave/mutateSave/mirrorCoins/
// grantTitleToPlayer, all plain findOne/findOneAndUpdate with $set, nothing FakeCollection doesn't support),
// and adds the branches achievements.e2e.test.ts's happy-path scenarios don't reach: coin-grant failure
// (durably-recorded-but-undelivered resilience), and the top-tier title-grant side effect.
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collections, CommercialClient, SaveData } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { claimAchievementHandler } from '../src/service/liveops/achievements.js';
import { MetaCore } from '../src/service/base.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeGateway } from './helpers/fakeClients.js';
import { AccountCache } from '../src/accountCache.js';

const jwt = { secret: 'test-secret' };

class FakeCommercial implements CommercialClient {
  readonly available = true;
  coins = new Map<string, number>();
  granted = new Set<string>();
  grantCalls = 0;
  failNextOrderId: string | null = null;
  bal(id: string) {
    return this.coins.get(id) ?? 0;
  }
  async getWallet(id: string) {
    return { coins: this.bal(id), pity: {} } as never;
  }
  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    this.grantCalls++;
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
}

interface FakeSaveDoc {
  _id: string;
  save: SaveData;
  rev: number;
}

function makeCols() {
  const saves = new FakeCollection<FakeSaveDoc>();
  const accounts = new FakeCollection<{ _id: string; [k: string]: unknown }>();
  const pveStamina = new FakeCollection<{ _id: string; current: number; regenAt: number }>();
  const cardInstances = new FakeCollection<{ _id: string; accountId: string; [k: string]: unknown }>();
  const cols = { saves, accounts, pveStamina, cardInstances } as unknown as Collections;
  return { cols, saves, accounts };
}

describe('achievements.ts (src import, coverage backfill)', () => {
  let app: FastifyInstance;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;
  let saves: FakeCollection<FakeSaveDoc>;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const claim = (achId: string, tier: number) =>
    app.inject({ method: 'POST', url: '/achievements/claim', headers: auth(), payload: { achId, tier } });
  const seedStats = (stats: Record<string, number>) =>
    saves.updateOne({ _id: accountId }, { $set: { 'save.stats': stats } });

  beforeEach(async () => {
    const built = makeCols();
    saves = built.saves;
    comm = new FakeCommercial();
    app = await buildApp({ cols: built.cols, jwt, internalKey: 'k', commercial: comm, authRateLimit: 0 });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `device-${randomUUID()}` } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // initialize save record
  });

  // ── GET /achievements ─────────────────────────────────────────────────────────────────────────
  describe('GET /achievements', () => {
    it('returns definition table + my stats + claimed progress', async () => {
      await seedStats({ 'kill.archer': 120 });
      const r = body(await app.inject({ method: 'GET', url: '/achievements', headers: auth() }));
      expect(r.ok).toBe(true);
      expect(r.data.defs.length).toBe(5);
      expect(r.data.stats['kill.archer']).toBe(120);
      expect(r.data.achievements).toEqual({});
    });

    it('no stats seeded at all -> stats/achievements default to {}', async () => {
      const r = body(await app.inject({ method: 'GET', url: '/achievements', headers: auth() }));
      expect(r.data.stats).toEqual({});
      expect(r.data.achievements).toEqual({});
    });
  });

  // ── POST /achievements/claim ──────────────────────────────────────────────────────────────────
  describe('POST /achievements/claim', () => {
    it('unknown achievement id -> 400 BAD_REQUEST (findAchievement guard, before mutateSave)', async () => {
      const r = await claim('ach.nope', 1);
      expect(r.statusCode).toBe(400);
      expect(body(r).error.code).toBe('BAD_REQUEST');
    });

    it('below threshold -> 400, no coins granted', async () => {
      await seedStats({ 'kill.archer': 50 });
      const r = await claim('ach.kill.archer', 1);
      expect(r.statusCode).toBe(400);
      expect(body(r).error.message).toBe('threshold not reached');
      expect(comm.bal(accountId)).toBe(0);
    });

    it('out-of-range tier within [1,3] (openapi schema cap): 400 before ever reaching the handler', async () => {
      // Every current achievement has exactly 3 tiers and the openapi schema itself caps `tier` at
      // [1,3] (contracts/openapi/paths/liveops.yml) — so validateClaim's own `tier > def.tiers.length`
      // BAD_REQUEST branch is never reachable through the public HTTP route today (schema and data both
      // happen to agree at the same ceiling). Covered directly below by calling the handler function
      // itself with a hand-built request, bypassing the schema gate the same way a future achievement
      // with fewer tiers eventually would in production.
      await seedStats({ 'kill.archer': 9999 });
      const r = await claim('ach.kill.archer', 9);
      expect(r.statusCode).toBe(400); // schema validation rejects tier=9 outright (>maximum:3)
    });

    it('invalid tier (validateClaim BAD_REQUEST branch, called directly — see the schema-cap note above)', async () => {
      const fresh = makeCols();
      const core = new MetaCore({
        cols: fresh.cols,
        jwt,
        now: () => Date.now(),
        commercial: comm,
        gatewayPublicUrl: null,
        gateway: fakeGateway(),
        authRateLimit: 0,
        flags: null,
        wordlists: null,
        region: null,
        lokiPushUrl: null,
        socialsvc: null,
        redis: null,
        accountCache: new AccountCache(),
      });
      const acc = 'acc-invalid-tier';
      await fresh.saves.updateOne(
        { _id: acc },
        { $setOnInsert: { _id: acc, save: { accountId: acc, rev: 1, stats: { 'kill.archer': 9999 }, wallet: { coins: 0 }, achievements: {} }, rev: 1 } },
        { upsert: true },
      );
      const req = { accountId: acc, body: { achId: 'ach.kill.archer', tier: 9 } } as unknown as FastifyRequest;
      let sent: { code: number; payload: unknown } | undefined;
      const reply = {
        code(c: number) { sent = { code: c, payload: undefined }; return this; },
        send(p: unknown) { sent!.payload = p; return this; },
      } as unknown as FastifyReply;
      await claimAchievementHandler(core, req, reply);
      expect(sent?.code).toBe(400);
      expect((sent?.payload as { error: { message: string } }).error.message).toBe('invalid tier');
    });

    it('happy path: grants tier coins + records claimedTiers', async () => {
      await seedStats({ 'kill.archer': 120 });
      const r = body(await claim('ach.kill.archer', 1));
      expect(r.ok).toBe(true);
      expect(r.data.granted).toBe(50);
      expect(r.data.save.wallet.coins).toBe(50);
      expect(r.data.save.achievements['ach.kill.archer'].claimedTiers).toEqual([1]);
    });

    it('duplicate claim same tier -> 409 ALREADY_CLAIMED, coins granted only once', async () => {
      await seedStats({ 'kill.archer': 120 });
      await claim('ach.kill.archer', 1);
      const dup = await claim('ach.kill.archer', 1);
      expect(dup.statusCode).toBe(409);
      expect(body(dup).error.code).toBe('ALREADY_CLAIMED');
      expect(comm.bal(accountId)).toBe(50);
    });

    it('multi-tier sequential claim: coins from tier I accumulate when claiming tier II', async () => {
      await seedStats({ 'kill.archer': 600 });
      await claim('ach.kill.archer', 1);
      const r2 = body(await claim('ach.kill.archer', 2));
      expect(r2.data.granted).toBe(100);
      expect(comm.bal(accountId)).toBe(150);
      expect(r2.data.save.achievements['ach.kill.archer'].claimedTiers.sort()).toEqual([1, 2]);
    });

    it('commercial unavailable -> 503 (ensureCommercial gate)', async () => {
      const built = makeCols();
      const app2 = await buildApp({ cols: built.cols, jwt, internalKey: 'k', commercialUrl: null });
      const r = await app2.inject({ method: 'POST', url: '/achievements/claim', headers: auth(), payload: { achId: 'ach.kill.archer', tier: 1 } });
      expect(r.statusCode).toBe(503);
      await app2.close();
    });

    it('coin grant fails after the tier is durably recorded: returns granted=0, but the tier stays claimed (no throw, no 5xx)', async () => {
      await seedStats({ 'kill.archer': 120 });
      const orderId = `ach:${accountId}:ach.kill.archer:1`;
      comm.failNextOrderId = orderId;
      const r = body(await claim('ach.kill.archer', 1));
      expect(r.ok).toBe(true);
      expect(r.data.granted).toBe(0);
      expect(r.data.save.achievements['ach.kill.archer'].claimedTiers).toEqual([1]);
      expect(comm.bal(accountId)).toBe(0);

      // A retry against the same already-claimed tier now just bounces with ALREADY_CLAIMED (the coin
      // delivery gap for a tier whose grant failed is a known, documented, accepted small-amount risk —
      // see claimAchievementHandler's own doc comment — there is no dedicated recovery branch here,
      // unlike retention.ts's checkin/weekly-chest handlers).
      const retry = await claim('ach.kill.archer', 1);
      expect(retry.statusCode).toBe(409);
    });

    it('final tier reached + achievement has a titleId -> grants the title (best-effort side effect)', async () => {
      await seedStats({ 'campaign.chaptersCleared': 9 }); // ach.campaign.chapters top tier (3) requires 9, titleId 'ach.all_chapters'
      await claim('ach.campaign.chapters', 1);
      await claim('ach.campaign.chapters', 2);
      const r = body(await claim('ach.campaign.chapters', 3));
      expect(r.ok).toBe(true);
      // The claim response's own `save` field is a mirrorCoins() snapshot taken BEFORE
      // grantTitleToPlayer runs (it fires after, best-effort, fire-and-forget) — assert the grant landed
      // via a follow-up read instead of the stale response snapshot.
      const after = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(after.data.save.titles).toContain('ach.all_chapters');
      expect(after.data.save.equipped.title).toBe('ach.all_chapters');
    });

    it('final tier reached but grantTitleToPlayer fails: best-effort, claim itself still succeeds (never throws)', async () => {
      await seedStats({ 'campaign.chaptersCleared': 9 });
      await claim('ach.campaign.chapters', 1);
      await claim('ach.campaign.chapters', 2);
      // Break the title-grant write specifically: findOneAndUpdate always misses (rev never matches),
      // grantTitleToPlayer exhausts its own retries and silently gives up (logged, not thrown).
      const realFindOneAndUpdate = saves.findOneAndUpdate.bind(saves);
      let call = 0;
      saves.findOneAndUpdate = (async (filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>, opts?: unknown) => {
        call++;
        // Let claimAchievementHandler's own mutateSave (the FIRST findOneAndUpdate this claim triggers)
        // through untouched; only the later grantTitleToPlayer write(s) are forced to miss.
        if (call === 1) return realFindOneAndUpdate(filter, update, opts as never);
        return null;
      }) as typeof saves.findOneAndUpdate;
      const r = body(await claim('ach.campaign.chapters', 3));
      expect(r.ok).toBe(true);
      expect(r.data.granted).toBe(400);
      // Title was never actually granted (every grantTitleToPlayer write attempt missed).
      const doc = await saves.findOne({ _id: accountId });
      expect(doc?.save.titles ?? []).not.toContain('ach.all_chapters');
    });

    it('red line: claim only changes coins (+ title on final tier), never touches ELO/rank/equipment/materials/PvE progress', async () => {
      await seedStats({ 'kill.archer': 120 });
      const before = body(await app.inject({ method: 'GET', url: '/save', headers: auth() })).data.save;
      const r = body(await claim('ach.kill.archer', 1));
      const after = r.data.save;
      expect(after.wallet.coins).toBe(before.wallet.coins + 50);
      expect(after.pvp).toEqual(before.pvp);
      expect(after.equipped).toEqual(before.equipped);
      expect(after.materials ?? {}).toEqual(before.materials ?? {});
      expect(after.stats).toEqual(before.stats);
    });
  });
});
