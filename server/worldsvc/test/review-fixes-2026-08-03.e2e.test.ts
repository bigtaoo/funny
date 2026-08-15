// Regression coverage for the 2026-08-03 worldsvc code review (claudedocs/server.md, "worldsvc 代码审查 + 修复
// （2026-08-03）"). One file per finding where a shared harness makes sense; the httpApi-level fixes (process-
// crash guard, readJson cap, senderName sanitize, admin numeric validation) live in httpApi.e2e.test.ts /
// season-ops.e2e.test.ts instead, since those need a real HTTP server. Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  playerWorldId,
  tileId,
  capitalIdxAt,
  SIEGE_LOOT_RATE,
  MARCH_MORALE_MAX,
  SLG_MAP_W,
  SLG_MAP_H,
  CARD_TROOP_PAPER_COST,
  CARD_TROOP_GRAPHITE_COST,
  CARD_TROOP_METAL_COST,
  CARD_TROOP_REFUND_RATE,
  SLG_SHOP_ITEMS,
  type CardInstance,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TeamTemplate, CardSLGState, MarchDoc, PlayerWorldDoc } from '../src/db';
import { WorldService } from '../src/service';
import { SectService } from '../src/sectService';
import type { WorldCommercialClient } from '../src/commercialClient';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldRedis } from '../src/redis';
import type { WorldSocialsvcClient, FamilyMembership, FamilySummary } from '../src/socialsvcClient';
import type { FamilyRole } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_review_fixes_test';
const W = 's1-review-fixes';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.review-fixes.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/** Any card id resolves to a minimal valid card (mirrors field-encounter.e2e.test.ts's CARD_INV_ANY). */
const CARD_INV_ANY: Record<string, CardInstance> = new Proxy({} as Record<string, CardInstance>, {
  get: (_t, prop: string) => ({ id: prop, defId: 'lichuang', level: 1, xp: 0, gear: {}, locked: false }),
});
const fakeMetaResolvesCards: WorldMetaClient = {
  available: true,
  async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: CARD_INV_ANY }; },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
};
/** cardInv resolves nothing — forces getTeams'/setTeams' sanitizeCardArmy to drop any team-assigned card. */
const fakeMetaNoCards: WorldMetaClient = {
  available: true,
  async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: {} }; },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
};

/** In-memory Redis: hash ops + an atomic hmergeJsonField matching the real Lua-script semantics in redis.ts. */
class FakeRedis implements WorldRedis {
  private hashes = new Map<string, Map<string, string>>();
  /** Call counters: a synchronous in-memory fake can't reliably reproduce the real network-latency race
   *  between hget and hset (no true concurrency to lose an update to), so the meaningful thing to assert
   *  is which code path core/push.ts actually takes — not the race outcome itself. */
  hsetCalls = 0;
  hmergeJsonFieldCalls = 0;
  async publish(): Promise<unknown> { return 0; }
  async hset(key: string, field: string, value: string): Promise<unknown> {
    this.hsetCalls++;
    let h = this.hashes.get(key);
    if (!h) { h = new Map(); this.hashes.set(key, h); }
    h.set(field, value);
    return 1;
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hdel(key: string, ...fields: string[]): Promise<unknown> {
    const h = this.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n++;
    return n;
  }
  async quit(): Promise<unknown> { return 'OK'; }
  occSize(worldId: string): number { return this.hashes.get(`world:${worldId}:occ`)?.size ?? 0; }
  /** Simulates the real client's Lua-script merge (redis.ts::MERGE_JSON_FIELD_SCRIPT) — single JS turn = atomic here. */
  async hmergeJsonField(key: string, field: string, entryKey: string, entryJson: string | null): Promise<unknown> {
    this.hmergeJsonFieldCalls++;
    let h = this.hashes.get(key);
    if (!h) { h = new Map(); this.hashes.set(key, h); }
    const cur = h.get(field);
    const map: Record<string, unknown> = cur ? JSON.parse(cur) : {};
    if (entryJson === null) delete map[entryKey];
    else map[entryKey] = JSON.parse(entryJson);
    if (Object.keys(map).length === 0) h.delete(field);
    else h.set(field, JSON.stringify(map));
    return 1;
  }
  coverMapAt(worldId: string, tid: string): Record<string, unknown> {
    const raw = this.hashes.get(`world:${worldId}:cover`)?.get(tid);
    return raw ? JSON.parse(raw) : {};
  }
}

describe.skipIf(!mongo)('worldsvc review-fixes regression (2026-08-03)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let redis: FakeRedis;
  let spent: { accountId: string; amount: number }[];
  let granted: { accountId: string; amount: number }[];

  // Hook fired inside spend(), i.e. exactly between buySlgShopItem's cheap pre-check and its
  // authoritative post-spend re-read — the only await in that window. Lets a test land a competing
  // write in that gap deterministically, instead of hoping the driver schedules a real concurrent
  // call into it (see the shop TOCTOU tests below).
  let onSpend: (() => Promise<void>) | null;

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend(accountId, amount) { spent.push({ accountId, amount }); if (onSpend) await onSpend(); },
    async grant(accountId, amount) { granted.push({ accountId, amount }); },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    spent = [];
    granted = [];
    onSpend = null;
    redis = new FakeRedis();
    svc = new WorldService({ cols: m.collections, redis, commercial: fakeCommercial, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  // ── Finding #2: city.ts card-removal refund duplicate exploit ──────────────────────────
  describe('city.ts: card-removal refund rev-guard (no double refund)', () => {
    async function seedStaleCardTeam(accountId: string, cardId: string, troops: number): Promise<void> {
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, accountId) },
        {
          $set: {
            teams: [{ id: 't1', name: 'T1', army: [{ cardInstanceId: cardId, col: 0, row: 1 }] }] as TeamTemplate[],
            [`cardState.${cardId}`]: { currentTroops: troops, teamId: 't1' } as CardSLGState,
          },
        },
      );
    }

    it('getTeams self-heal: concurrent calls refund the freed card exactly once', async () => {
      const noCardSvc = new WorldService({ cols: m.collections, redis, commercial: fakeCommercial, meta: fakeMetaNoCards, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
      await noCardSvc.joinWorld(W, 'a', 10, 10);
      await seedStaleCardTeam('a', 'ghost-card', 1000);

      // Both calls read the same pre-removal cardState snapshot (card unresolvable via cardInv → self-heal
      // drops it from every team and refunds 80% of its training cost) — without the rev guard, both
      // independently $inc the same refund amount.
      await Promise.all([noCardSvc.getTeams(W, 'a'), noCardSvc.getTeams(W, 'a')]);

      const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
      expect(pw!.cardState!['ghost-card']!.currentTroops).toBe(0);
      expect(pw!.resources.paper).toBe(Math.floor(1000 * CARD_TROOP_PAPER_COST * CARD_TROOP_REFUND_RATE));
      expect(pw!.resources.graphite).toBe(Math.floor(1000 * CARD_TROOP_GRAPHITE_COST * CARD_TROOP_REFUND_RATE));
      expect(pw!.resources.metal).toBe(Math.floor(1000 * CARD_TROOP_METAL_COST * CARD_TROOP_REFUND_RATE));
    });

    it('setTeams: concurrent explicit removals — exactly one commits, the other hits REV_CONFLICT (no double refund)', async () => {
      const noCardSvc = new WorldService({ cols: m.collections, redis, commercial: fakeCommercial, meta: fakeMetaNoCards, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
      await noCardSvc.joinWorld(W, 'a', 15, 15);
      await seedStaleCardTeam('a', 'ghost-card2', 500);

      const results = await Promise.allSettled([
        noCardSvc.setTeams(W, 'a', []),
        noCardSvc.setTeams(W, 'a', []),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as { code?: string }).code).toBe('REV_CONFLICT');

      const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
      expect(pw!.resources.paper).toBe(Math.floor(500 * CARD_TROOP_PAPER_COST * CARD_TROOP_REFUND_RATE));
    });
  });

  // ── Finding #5: city.ts speedupTraining rev-guard + retry (concurrent speedups don't clobber each other) ──
  describe('city.ts: speedupTraining rev-guard retries instead of losing a concurrent speedup', () => {
    it('two concurrent 1-coin speedups both apply — the queue reflects TWO reductions, not one', async () => {
      await svc.joinWorld(W, 'a', 10, 10);
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'a') },
        { $set: { troops: 0, resources: { ink: 1_000_000, paper: 1_000_000, graphite: 1_000_000, metal: 1_000_000, sticker: 1_000_000 } } },
      );
      // A big batch (qty=1000 → 5000s duration) so a 2x60s reduction never drains it — isolates the
      // "did both reductions land" question from any "did the batch complete" complication.
      const seeded = await svc.trainTroops(W, 'a', 1000);
      const originalCompleteAt = seeded.trainingQueue![0]!.completeAt;

      // Both calls independently read the queue, spend a coin, then re-fetch+compute+write. Before the fix,
      // speedupTraining's finalize write carried no rev guard — both calls' "fresh re-fetch" could see the
      // SAME pre-reduction queue, both compute the SAME 60s-shorter completeAt, and whichever write landed
      // last would leave only ONE reduction applied despite two coins spent.
      await Promise.all([
        svc.speedupTraining(W, 'a', 1),
        svc.speedupTraining(W, 'a', 1),
      ]);

      const after = await svc.getMe(W, 'a');
      const REDUCTION_MS = 60_000; // TROOP_SPEEDUP_SECS_PER_COIN(60) * 1000, 1 coin each
      expect(originalCompleteAt - after.trainingQueue![0]!.completeAt).toBe(REDUCTION_MS * 2);
    });
  });

  // ── Finding #3 + #17: combatMarch card-army refund guard + stale-march occupancy guard ──
  describe('combatMarch: card-army return marches never refund the flat troop pool', () => {
    async function setupCardTeam(accountId: string, teamId: string, cardId: string, troops: number): Promise<void> {
      const cardSvc = new WorldService({ cols: m.collections, redis, commercial: fakeCommercial, meta: fakeMetaResolvesCards, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
      await cardSvc.setTeams(W, accountId, [{ id: teamId, name: teamId, army: [{ cardInstanceId: cardId, col: 0, row: 1 }] }] as TeamTemplate[]);
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, accountId) },
        { $set: { [`cardState.${cardId}`]: { currentTroops: troops, teamId } as CardSLGState } },
      );
    }

    it('recallMarch → return-leg arrival does not credit the pool for a card-army march', async () => {
      const cardSvc = new WorldService({ cols: m.collections, redis, commercial: fakeCommercial, meta: fakeMetaResolvesCards, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
      await cardSvc.joinWorld(W, 'a', 10, 10);
      await setupCardTeam('a', 'at1', 'card-a', 500);
      // 'move' has no ADR-039 connectivity requirement (unlike occupy/attack) — no connector tile needed.
      const mv = await cardSvc.startMarch(W, 'a', 10, 10, 12, 10, 'move', 1, 'at1');
      const before = (await cardSvc.getMe(W, 'a')).troops;

      const recalled = await cardSvc.recallMarch(W, 'a', mv.marchId);
      nowMs = recalled.arriveAt;
      expect(await cardSvc.processDueArrivals()).toBe(1);

      const after = await cardSvc.getMe(W, 'a');
      expect(after.troops).toBe(before); // no free troops from the card-count-as-troops march.troops field
    });

    it('instantReturnMarch does not credit the pool for a card-army march', async () => {
      const cardSvc = new WorldService({ cols: m.collections, redis, commercial: fakeCommercial, meta: fakeMetaResolvesCards, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
      await cardSvc.joinWorld(W, 'b', 20, 20);
      await setupCardTeam('b', 'bt1', 'card-b', 500);
      const mv = await cardSvc.startMarch(W, 'b', 20, 20, 22, 20, 'move', 1, 'bt1');
      const before = (await cardSvc.getMe(W, 'b')).troops;
      await cardSvc.recallMarch(W, 'b', mv.marchId);

      await cardSvc.instantReturnMarch(W, 'b', mv.marchId);
      const after = await cardSvc.getMe(W, 'b');
      expect(after.troops).toBe(before);
    });
  });

  describe('combatMarch/arrival.ts: advanceMarch bails out on a mid-batch stale snapshot (no phantom occupancy)', () => {
    it('march already removed (destroyed by a concurrent encounter this batch) → no occupancy write, no reschedule', async () => {
      await svc.joinWorld(W, 'ghost', 5, 5);
      const path = [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 5 }];
      const doc: MarchDoc = {
        _id: 'ghost-stale-march', worldId: W, ownerId: 'ghost', fromTile: tileId(W, 5, 5), toTile: tileId(W, 7, 5),
        kind: 'reinforce', troops: 100, morale: MARCH_MORALE_MAX,
        departAt: now() - 1000, arriveAt: now() + 10_000, path, stepIndex: 0, nextStepAt: now() - 1,
        status: 'marching', rev: 0,
      };
      await m.collections.marches.insertOne(doc);
      const staleSnapshot: MarchDoc = { ...doc };
      // Simulate: an earlier march's field encounter, processed earlier in the same processDueArrivals batch,
      // destroyed this march (findOneAndDelete) — its Mongo doc is gone, but `staleSnapshot` still has the old
      // path/stepIndex cursor, exactly like the stale `due[]` entry would.
      await m.collections.marches.deleteOne({ _id: 'ghost-stale-march' });

      // 2026-08-11 mixin-chain split: advanceMarch moved from a private MarchService (mixin) method
      // to a private ArrivalService (sibling class) method — reach it via the facade's `arrival` field.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handled = await (svc as any).combat.march.arrival.advanceMarch(staleSnapshot, now() + 1);
      expect(handled).toBe(true); // fully handled — must not be rescheduled
      expect(redis.occSize(W)).toBe(0); // no phantom occ entry registered for the deleted march
    });

    it('march concurrently recalled (cursor unset, kind flipped to return) → no occupancy write, no crash', async () => {
      await svc.joinWorld(W, 'ghost2', 8, 8);
      const path = [{ x: 8, y: 8 }, { x: 9, y: 8 }, { x: 10, y: 8 }];
      const doc: MarchDoc = {
        _id: 'ghost-recalled-march', worldId: W, ownerId: 'ghost2', fromTile: tileId(W, 8, 8), toTile: tileId(W, 10, 8),
        kind: 'reinforce', troops: 100, morale: MARCH_MORALE_MAX,
        departAt: now() - 1000, arriveAt: now() + 10_000, path, stepIndex: 0, nextStepAt: now() - 1,
        status: 'marching', rev: 0,
      };
      await m.collections.marches.insertOne(doc);
      const staleSnapshot: MarchDoc = { ...doc };
      // Simulate recallMarch's effect: cursor unset, kind flipped to 'return' — doc still exists (status
      // stays 'marching' during transit) but is no longer a stepping march.
      await m.collections.marches.updateOne(
        { _id: 'ghost-recalled-march' },
        { $set: { kind: 'return', fromTile: doc.toTile, toTile: doc.fromTile }, $unset: { path: '', stepIndex: '', nextStepAt: '' } },
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handled = await (svc as any).combat.march.arrival.advanceMarch(staleSnapshot, now() + 1);
      expect(handled).toBe(true);
      expect(redis.occSize(W)).toBe(0);
    });
  });

  // ── Finding #4: shared playerWorld resources/troops rev-guard + retry ──────────────────
  describe('combatShared.ts refundTroops: concurrent scheduler tasks touching the same player never lose a delta', () => {
    it('two concurrent processDueArrivals() calls settling two different return marches for the same account both land', async () => {
      await svc.joinWorld(W, 'a', 10, 10);
      // A fresh capital starts with troops already AT troopCap — drain it so the refunds below are observable
      // (otherwise Math.min(troopCap, troops+refund) silently clamps and hides a lost update).
      await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { troops: 0 } });
      const t0 = now();
      const r1: MarchDoc = {
        _id: 'r1', worldId: W, ownerId: 'a', fromTile: tileId(W, 20, 20), toTile: tileId(W, 10, 10),
        kind: 'return', troops: 100, morale: MARCH_MORALE_MAX, departAt: t0 - 1000, arriveAt: t0 - 1, status: 'marching', rev: 0,
      };
      const r2: MarchDoc = {
        _id: 'r2', worldId: W, ownerId: 'a', fromTile: tileId(W, 21, 21), toTile: tileId(W, 10, 10),
        kind: 'return', troops: 150, morale: MARCH_MORALE_MAX, departAt: t0 - 1000, arriveAt: t0 - 1, status: 'marching', rev: 0,
      };
      await m.collections.marches.insertOne(r1);
      await m.collections.marches.insertOne(r2);
      const before = (await svc.getMe(W, 'a')).troops;

      await Promise.all([svc.processDueArrivals(), svc.processDueArrivals()]);

      const after = (await svc.getMe(W, 'a')).troops;
      expect(after - before).toBe(250); // both refunds landed — neither lost to the race
      expect(await m.collections.marches.findOne({ _id: 'r1' })).toBeNull();
      expect(await m.collections.marches.findOne({ _id: 'r2' })).toBeNull();
    });
  });

  describe('combatSiege/helpers.ts transferLoot: concurrent calls on the same defender/attacker never lose a delta', () => {
    it('two concurrent transferLoot calls both extract loot (conservation, no dupe, no drop)', async () => {
      await svc.joinWorld(W, 'def', 30, 30);
      await svc.joinWorld(W, 'atk', 40, 40);
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'def') },
        { $set: { resources: { ink: 1000, paper: 1000, graphite: 1000, metal: 1000, sticker: 1000 } } },
      );
      const defDoc = (await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'def') }))!;
      const atkDoc = (await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'atk') }))!;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const siege = (svc as any).combat.siege;
      // Both calls start from the SAME stale snapshot — simulates two concurrent siege settlements that both
      // read the defender/attacker docs before either commits.
      await Promise.all([
        siege.transferLoot(defDoc, atkDoc, now()),
        siege.transferLoot(defDoc, atkDoc, now()),
      ]);

      const defAfter = await svc.getMe(W, 'def');
      const atkAfter = await svc.getMe(W, 'atk');
      const singleLoot = Math.floor(1000 * SIEGE_LOOT_RATE);
      const defLost = 1000 - defAfter.resources!.ink;
      const atkGained = atkAfter.resources!.ink - 0;
      // Conservation: whatever the defender lost, the attacker gained (no resources created/destroyed).
      expect(atkGained).toBe(defLost);
      // Both extractions actually happened — total loot exceeds one single extraction (would equal exactly
      // `singleLoot` if the second call's delta had been lost to the race).
      expect(defLost).toBeGreaterThan(singleLoot);
      expect(defLost).toBeLessThan(singleLoot * 2);
    });
  });

  // ── Finding #9: shop.ts daily-limit TOCTOU ──────────────────────────────────────────────
  describe('shop.ts: buySlgShopItem daily-limit is TOCTOU-safe (refunds the losers)', () => {
    it('concurrent purchases at the limit boundary: exactly one more purchase lands, the rest are refunded', async () => {
      await svc.joinWorld(W, 'a', 10, 10);
      const item = SLG_SHOP_ITEMS.find((i) => i.id === 'slg_res_s')!;
      expect(item.dailyLimit).toBe(5);
      const today = Math.floor(now() / 86_400_000);
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'a') },
        { $set: { shopPurchaseCounts: { slg_res_s: { day: today, count: item.dailyLimit! - 1 } } } },
      );

      const results = await Promise.allSettled([
        svc.buySlgShopItem(W, 'a', 'slg_res_s'),
        svc.buySlgShopItem(W, 'a', 'slg_res_s'),
        svc.buySlgShopItem(W, 'a', 'slg_res_s'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(2);
      for (const r of rejected) expect((r.reason as { code?: string }).code).toBe('SHOP_LIMIT_REACHED');

      // Coin conservation: every attempt that got past the cheap pre-check paid, and every one of
      // those that then lost the race got refunded — so exactly one net spend, whatever the
      // interleaving. How many attempts clear the pre-check is deliberately NOT asserted: it is a
      // cheap early rejection against a possibly-stale read (see shop.ts), so an attempt whose read
      // lands after the winner's write rejects for free without ever spending. Pinning it to 3 made
      // this test flaky — it failed on CI 2026-08-15 with spent=2 when the driver's connection pool
      // happened to serve one findOne after the winner had already committed. The refund path itself
      // is covered deterministically by the next test.
      expect(spent.length).toBeGreaterThanOrEqual(1);
      expect(spent.length).toBeLessThanOrEqual(3);
      expect(granted).toHaveLength(spent.length - 1);
      expect(granted.every((g) => g.amount === item.cost)).toBe(true);

      const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
      expect(pw!.shopPurchaseCounts!['slg_res_s']!.count).toBe(item.dailyLimit); // capped exactly at the limit
    });

    it('an attempt that passes the pre-check but loses the race is refunded, not oversold', async () => {
      await svc.joinWorld(W, 'a', 10, 10);
      const item = SLG_SHOP_ITEMS.find((i) => i.id === 'slg_res_s')!;
      const today = Math.floor(now() / 86_400_000);
      await m.collections.playerWorld.updateOne(
        { _id: playerWorldId(W, 'a') },
        { $set: { shopPurchaseCounts: { slg_res_s: { day: today, count: item.dailyLimit! - 1 } } } },
      );

      // The pre-check reads count = limit-1 and lets the purchase through; the competing buy then
      // fills the last slot while this one is inside spend(). No timing assumptions: onSpend fires
      // in exactly that window by construction.
      onSpend = async () => {
        await m.collections.playerWorld.updateOne(
          { _id: playerWorldId(W, 'a') },
          { $set: { shopPurchaseCounts: { slg_res_s: { day: today, count: item.dailyLimit! } } } },
        );
      };

      await expect(svc.buySlgShopItem(W, 'a', 'slg_res_s')).rejects.toMatchObject({ code: 'SHOP_LIMIT_REACHED' });

      expect(spent).toHaveLength(1); // it did pay...
      expect(granted).toHaveLength(1); // ...and got every coin back
      expect(granted[0]!.amount).toBe(item.cost);

      const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
      expect(pw!.shopPurchaseCounts!['slg_res_s']!.count).toBe(item.dailyLimit); // no oversell
    });
  });

  // ── Finding #10: core/nation.ts $unset familyId + content moderation ────────────────────
  describe('core/nation.ts: applyNationChange familyId + setNationName moderation', () => {
    it('applyNationChange $unsets familyId when the new winner has no family (not left stale)', async () => {
      await svc.initNations(W); // applyNationChange's updateOne has no upsert — the NationDoc must pre-exist
      const caps = svc.capitalsFor(W);
      const [cx, cy] = caps[0]!;
      const idx = capitalIdxAt(cx, cy, caps);
      const nationId = `nation:${W}:${idx}`;

      await svc.applyNationChange(W, cx, cy, 'winnerA', 'famA');
      expect((await m.collections.nations.findOne({ _id: nationId }))!.familyId).toBe('famA');

      await svc.applyNationChange(W, cx, cy, 'winnerB', undefined);
      const doc = await m.collections.nations.findOne({ _id: nationId });
      expect(doc!.ownerId).toBe('winnerB');
      expect(doc!.familyId).toBeUndefined();
    });

    it('setNationName enforces width bounds (2-12 display units) and content moderation, matching sect/family names', async () => {
      await svc.initNations(W);
      const caps = svc.capitalsFor(W);
      const [cx, cy] = caps[1]!;
      const idx = capitalIdxAt(cx, cy, caps);
      await svc.applyNationChange(W, cx, cy, 'namer', undefined);

      await expect(svc.setNationName(W, 'namer', idx, 'x')).rejects.toMatchObject({ code: 'BAD_REQUEST' }); // width 1 < 2
      await expect(svc.setNationName(W, 'namer', idx, '七个汉字超限了')).rejects.toMatchObject({ code: 'BAD_REQUEST' }); // 7*2=14 > 12
      // 'shit' is in chatFilter.ts's global word list, always active regardless of region.
      await expect(svc.setNationName(W, 'namer', idx, 'Shit Nation')).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await svc.setNationName(W, 'namer', idx, 'Good Nation');
      const nations = await svc.getNations(W);
      expect(nations.find((n) => n._id === `nation:${W}:${idx}`)!.nationName).toBe('Good Nation');
    });
  });

  // ── Finding #11: core/push.ts cover-index atomic merge ──────────────────────────────────
  describe('core/push.ts: addCover/removeCover use the atomic merge when the Redis client supports it', () => {
    it('two overlapping footprints added concurrently both survive (no lost update)', async () => {
      const tidShared = tileId(W, 11, 10); // inside both (10,10)'s and (12,10)'s 3x3 footprints
      await Promise.all([
        svc.addCover(W, 10, 10, { kind: 'garrison', sourceTile: tileId(W, 10, 10), ownerId: 'a', teamId: 'ta' }),
        svc.addCover(W, 12, 10, { kind: 'garrison', sourceTile: tileId(W, 12, 10), ownerId: 'b', teamId: 'tb' }),
      ]);
      const map = redis.coverMapAt(W, tidShared);
      expect(Object.keys(map)).toHaveLength(2);
      expect(map[tileId(W, 10, 10)]).toBeDefined();
      expect(map[tileId(W, 12, 10)]).toBeDefined();

      // Removing one source only clears its own entry, not the other's.
      await svc.removeCover(W, 10, 10, tileId(W, 10, 10));
      const after = redis.coverMapAt(W, tidShared);
      expect(Object.keys(after)).toHaveLength(1);
      expect(after[tileId(W, 12, 10)]).toBeDefined();
    });

    it('actually takes the atomic hmergeJsonField path, not the old plain hset read-modify-write', async () => {
      // A synchronous in-memory fake can't reliably reproduce the real network-latency race between
      // hget and hset (there's no true concurrency to lose an update to), so the meaningful regression
      // check is which code path core/push.ts takes when the client supports the atomic merge.
      await svc.addCover(W, 30, 30, { kind: 'garrison', sourceTile: tileId(W, 30, 30), ownerId: 'c', teamId: 'tc' });
      expect(redis.hmergeJsonFieldCalls).toBeGreaterThan(0);
      expect(redis.hsetCalls).toBe(0);

      await svc.removeCover(W, 30, 30, tileId(W, 30, 30));
      expect(redis.hmergeJsonFieldCalls).toBeGreaterThan(9); // 9 cells x 2 ops (add + remove)
      expect(redis.hsetCalls).toBe(0);
    });
  });

  // ── Finding #12: sectService.ts voteRemoveLeader rev-guard + retry ──────────────────────
  describe('sectService.ts: voteRemoveLeader concurrent votes are never lost', () => {
    class FakeSocialsvc implements WorldSocialsvcClient {
      available = true;
      private families = new Map<string, FamilySummary & { activity: number }>();
      private memberRole = new Map<string, { familyId: string; role: FamilyRole }>();
      addFamily(leaderId: string, name: string, tag: string): string {
        const familyId = `fam:${tag.toUpperCase()}`;
        this.families.set(familyId, { familyId, name, tag: tag.toUpperCase(), leaderId, memberCount: 1, prosperity: 0, prosperityUpdatedAt: 0, activity: 500 });
        this.memberRole.set(leaderId, { familyId, role: 'leader' });
        return familyId;
      }
      async getFamilyId(accountId: string) { return this.memberRole.get(accountId)?.familyId ?? null; }
      async getMember(accountId: string): Promise<FamilyMembership | null> {
        const mm = this.memberRole.get(accountId);
        if (!mm) return null;
        const f = this.families.get(mm.familyId)!;
        return { familyId: mm.familyId, role: mm.role, leaderId: f.leaderId, name: f.name, tag: f.tag, memberCount: f.memberCount, ...(f.sectId ? { sectId: f.sectId } : {}) };
      }
      async getFamiliesByIds(familyIds: string[]): Promise<FamilySummary[]> {
        return familyIds.map((id) => this.families.get(id)).filter((f): f is FamilySummary & { activity: number } => !!f).map((f) => ({ ...f }));
      }
      async getFamiliesBySect(sid: string) { return [...this.families.values()].filter((f) => f.sectId === sid).map((f) => ({ ...f })); }
      async setSect(familyId: string, sid: string | null) {
        const f = this.families.get(familyId);
        if (!f) return;
        if (sid) f.sectId = sid; else delete f.sectId;
      }
      async bumpActivity() { /* no-op */ }
      async refreshProsperity() { return 0; }
      async resetSlgState() { /* no-op */ }
      async push() { /* no-op */ }
    }

    async function joinAsPlayerWorld(accountId: string, familyId: string): Promise<void> {
      await m.collections.playerWorld.insertOne({
        _id: `${W}:${accountId}`, worldId: W, accountId, troops: 0, troopCap: 0,
        resources: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
        yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
        lastTickAt: 0, familyId, rev: 0,
      });
    }

    it('two family leaders voting for the same nominee at once both get counted (needed=3 stays reachable, not stuck at 1)', async () => {
      const socialsvc = new FakeSocialsvc();
      const sect = new SectService({ cols: m.collections, commercial: fakeCommercial, socialsvc, now });
      const aa = socialsvc.addFamily('alice', 'Alpha', 'AA');
      const bb = socialsvc.addFamily('bob', 'Bravo', 'BB');
      const cc = socialsvc.addFamily('carol', 'Charlie', 'CC');
      const dd = socialsvc.addFamily('dave', 'Delta', 'DD');
      for (const [acct, fid] of [['alice', aa], ['bob', bb], ['carol', cc], ['dave', dd]] as const) {
        await joinAsPlayerWorld(acct, fid);
      }
      const s = await sect.createSect(W, 'alice', 'VoteSect', 'VOTE');
      await sect.joinSect(W, 'bob', s.sectId);
      await sect.joinSect(W, 'carol', s.sectId);
      await sect.joinSect(W, 'dave', s.sectId);
      // 4 families → needed = ceil(4 * 2/3) = 3

      await Promise.all([
        sect.voteRemoveLeader(W, 'bob', dd),
        sect.voteRemoveLeader(W, 'carol', dd),
      ]);

      const after = await sect.getSect(s.sectId);
      expect(after!.removalVote?.nomineeFamilyId).toBe(dd);
      expect(after!.removalVote?.voteCount).toBe(2); // both votes counted, neither lost to the race

      // SectDetailView only exposes the count — check the raw doc for the actual voter family ids.
      const raw = await m.collections.sects.findOne({ _id: s.sectId });
      expect(raw!.removalVote?.voterFamilyIds).toHaveLength(2);
      expect(raw!.removalVote?.voterFamilyIds.slice().sort()).toEqual([bb, cc].sort());
    });
  });

  // ── Finding #13: core/spawn.ts pickSpawnTile excludes base-ring cells from the mate lookup ──
  describe('core/spawn.ts: pickSpawnTile mate-base query excludes ring cells', () => {
    it('the family-member base lookup filters out baseRing cells (only anchors counted)', async () => {
      await svc.joinWorld(W, 'mate', 25, 25);
      await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'mate') }, { $set: { familyId: 'fam1' } });
      const mateDoc = await svc.getMe(W, 'mate');
      const anchorTid = mateDoc.mainBaseTile!;

      // Sanity: the anchor + 8 ring cells really are all persisted as type:'base' (ADR-025).
      const allBaseCells = await m.collections.tiles.find({ worldId: W, type: 'base', ownerId: { $in: ['mate'] } }).toArray();
      expect(allBaseCells.length).toBe(9);

      // Spy on the actual query pickSpawnTile issues (not a hand-rolled query of our own — that would just
      // tautologically pass regardless of what spawn.ts's real code does) and check its filter.
      const findSpy = vi.spyOn(m.collections.tiles, 'find');
      const spot = await svc.pickSpawnTile(W, 'newcomer', 'fam1');
      expect(spot).not.toBeNull();

      const mateBaseLookupCall = findSpy.mock.calls.find(([q]) => {
        const query = q as { type?: unknown; ownerId?: { $in?: unknown[] } };
        return query.type === 'base' && query.ownerId?.$in?.includes('mate');
      });
      expect(mateBaseLookupCall).toBeDefined();
      expect((mateBaseLookupCall![0] as { baseRing?: unknown }).baseRing).toEqual({ $ne: true });

      // And behaviorally: the query itself, run directly, must return only the anchor (not all 9 cells).
      const bases = await m.collections.tiles.find(mateBaseLookupCall![0] as Record<string, unknown>).toArray();
      expect(bases).toHaveLength(1);
      expect(bases[0]!._id).toBe(anchorTid);
      findSpy.mockRestore();
    });
  });
});
