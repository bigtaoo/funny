// Branch-coverage backfill for src/service/pve/helpers.ts + src/service/pve/stamina.ts (2026-09-03
// branch-coverage task, group E). test/pve-service-unit.test.ts drives both through /pve/clear,
// /pve/enter and /pve/stamina/purchase; what it cannot reach from there is added here by calling the
// exported helpers directly:
//
//  * absent-field fallbacks on data that arrives from outside (a zero/absent entry in the client's
//    unitLevels snapshot, a save with no `stats` block yet).
//  * the stamina document being missing or half-written when it is read back (`!stDoc`, `stDoc?.current
//    ?? CAP`, `stDoc?.regenAt ?? 0`) and the atomic deduction losing its race — the two places that
//    decide whether a player is charged twice or refused entry.
//  * the regen tick that fills the bar exactly to the cap (regenAt must go back to 0, not keep ticking).
//  * grantChapterClearCard's three "nothing to grant" exits, including a chapter whose anchor card id
//    has no CardDef — the guard that keeps a mis-seeded anchor table from crashing a clear.
//  * purchaseStaminaHandler's `amount !== 60` refusal, which the route schema rejects first over HTTP.
//
// Real Mongo (own DB, shared rs0 instance): grantCards uses $addToSet-with-$each, which
// test/helpers/fakeCollection.ts does not implement.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  createMongo, makeNewSave, CHAPTER_ANCHOR_CARD,
  type Collections, type JwtConfig, type MongoHandle, type SaveData,
} from '@nw/shared';
import type { CommercialClient } from '../src/commercialClient.js';
import { STAMINA_CAP, STAMINA_REGEN_MS, type ServiceDeps } from '../src/service/base.js';
import { AccountCache } from '../src/accountCache.js';
import { getOrCreateSave } from '../src/save.js';
import { normUpgrades, applyClearProgress, deductStamina, grantChapterClearCard } from '../src/service/pve/helpers.js';
import { purchaseStaminaHandler } from '../src/service/pve/stamina.js';
import { fakeGateway } from './helpers/fakeClients.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_grpE_branch_test_helpers';
const jwt: JwtConfig = { secret: 'test-secret' };
const NOW = 1_800_000_000_000;
const ACC = 'acc-grpE-pve-helpers';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (e) {
    if (process.env.NW_REQUIRE_DB) throw e;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[liveops-pve-branch-pve-helpers] Mongo unreachable (${URI}) — skipping.`);

const commercial = {
  available: true,
  async spend() {
    return { ok: true as const, coinsAfter: 0 };
  },
  async grant(a: { amount: number }) {
    return { ok: true as const, coinsAfter: a.amount };
  },
} as unknown as CommercialClient;

function makeReply() {
  const sent: { code?: number; payload?: unknown } = {};
  const reply = {
    code(c: number) { sent.code = c; return reply; },
    send(p: unknown) { sent.payload = p; return reply; },
  };
  return { sent, reply: reply as unknown as FastifyReply };
}

const req = (body: unknown) => ({ accountId: ACC, body, headers: {}, log: { warn() {} } }) as unknown as FastifyRequest;

describe('pve helpers/stamina branch backfill (group E)', () => {
  // ── pure helpers (no I/O) ─────────────────────────────────────────────────────────────────────
  it('normUpgrades drops keys whose value is missing entirely (the client omits a unit it never levelled)', () => {
    const raw = { infantry: 2, archer: undefined, shield: 0 } as unknown as Record<string, number>;
    expect(normUpgrades(raw)).toEqual({ infantry: 2 });
  });

  it('applyClearProgress seeds the chaptersCleared stat lazily: no stats block at all, and a stats block without the key', () => {
    const base = makeNewSave(ACC, NOW);
    const cleared = ['ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4', 'ch1_lv5', 'ch1_lv6', 'ch1_lv7', 'ch1_lv8', 'ch1_lv9'];

    const noStats: SaveData = { ...base, progress: { cleared, stars: {}, best: {} } };
    delete (noStats as { stats?: unknown }).stats;
    const a = applyClearProgress(noStats, 'ch1_lv10', 3);
    expect(a.newlyClearedChapter).toBe('ch1');
    expect(a.next.stats?.['campaign.chaptersCleared']).toBe(1);

    const otherStats: SaveData = { ...base, progress: { cleared, stars: {}, best: {} }, stats: { 'kill.archer': 7 } };
    const b = applyClearProgress(otherStats, 'ch1_lv10', 3);
    expect(b.next.stats).toEqual({ 'kill.archer': 7, 'campaign.chaptersCleared': 1 });
  });

  describe.skipIf(!mongo)('Mongo-backed helpers', () => {
    const m = mongo!;

    beforeEach(async () => {
      await m.db.dropDatabase();
      await m.ensureIndexes();
      await getOrCreateSave(m.collections, ACC, NOW);
    });

    afterAll(async () => {
      await m.db.dropDatabase();
      await m.close();
    });

    function deps(cols: Collections): ServiceDeps {
      return {
        cols, jwt, now: () => NOW, commercial,
        gatewayPublicUrl: null, gateway: fakeGateway(), authRateLimit: 0,
        flags: null, wordlists: null, region: null, lokiPushUrl: null,
        socialsvc: null, redis: null, accountCache: new AccountCache(),
      } as ServiceDeps;
    }

    /** Real collections with pveStamina's findOne / findOneAndUpdate overridden. */
    function colsWithStamina(over: { findOne?: () => Promise<unknown>; findOneAndUpdate?: () => Promise<unknown> }): Collections {
      const real = m.collections.pveStamina;
      return {
        ...m.collections,
        pveStamina: {
          findOne: over.findOne ?? real.findOne.bind(real),
          updateOne: real.updateOne.bind(real),
          findOneAndUpdate: over.findOneAndUpdate ?? real.findOneAndUpdate.bind(real),
        },
      } as unknown as Collections;
    }

    // ── deductStamina ───────────────────────────────────────────────────────────────────────────
    it('stamina document missing on read-back: entry is refused rather than granted for free', async () => {
      const r = await deductStamina(colsWithStamina({ findOne: async () => null }), ACC, 10, NOW);
      expect(r).toEqual({ ok: false });
    });

    it('regen ticks that fill the bar exactly to the cap clear the regen timer instead of leaving it running', async () => {
      await m.collections.pveStamina.updateOne(
        { _id: ACC },
        { $set: { current: STAMINA_CAP - 1, regenAt: NOW - 1 } },
        { upsert: true },
      );
      const r = await deductStamina(m.collections, ACC, 10, NOW);
      expect(r).toEqual({ ok: true, current: STAMINA_CAP - 10, regenAt: NOW + STAMINA_REGEN_MS });
      // The one tick took the bar to 120 (timer cleared), and only then did this entry's cost restart it.
    });

    it('a zero-cost entry on a full bar does not start a regen timer', async () => {
      await m.collections.pveStamina.updateOne({ _id: ACC }, { $set: { current: STAMINA_CAP, regenAt: 0 } }, { upsert: true });
      const r = await deductStamina(m.collections, ACC, 0, NOW);
      expect(r).toEqual({ ok: true, current: STAMINA_CAP, regenAt: 0 });
    });

    it('losing the atomic deduction race refuses the entry (no stamina is spent by the loser)', async () => {
      const cols = colsWithStamina({ findOneAndUpdate: async () => null });
      const r = await deductStamina(cols, ACC, 10, NOW);
      expect(r).toEqual({ ok: false });
    });

    // ── grantChapterClearCard ───────────────────────────────────────────────────────────────────
    it('a chapter with no anchor card in the table grants nothing (and does not throw)', async () => {
      const out = await grantChapterClearCard(m.collections, () => NOW, commercial, ACC, 'ch99');
      expect(out).toBeUndefined();
      expect(await m.collections.cardInstances.countDocuments({ accountId: ACC })).toBe(0);
    });

    it('an anchor card id with no CardDef grants nothing (guards a mis-seeded anchor table)', async () => {
      // Adding a chapter to CHAPTER_ANCHOR_CARD without adding its CardDef is the exact mistake this
      // guard exists for; restored immediately below.
      (CHAPTER_ANCHOR_CARD as Record<string, string>)['ch_ghost'] = 'no_such_card_def';
      try {
        const out = await grantChapterClearCard(m.collections, () => NOW, commercial, ACC, 'ch_ghost');
        expect(out).toBeUndefined();
        expect(await m.collections.cardInstances.countDocuments({ accountId: ACC })).toBe(0);
      } finally {
        delete (CHAPTER_ANCHOR_CARD as Record<string, string>)['ch_ghost'];
      }
    });

    it('a chapter card grant that loses every rev race is swallowed: the clear it rides along with is not rolled back', async () => {
      const realSaves = m.collections.saves;
      const cols = {
        ...m.collections,
        saves: {
          findOne: realSaves.findOne.bind(realSaves),
          updateOne: realSaves.updateOne.bind(realSaves),
          findOneAndUpdate: async () => null,
        },
      } as unknown as Collections;
      const out = await grantChapterClearCard(cols, () => NOW, commercial, ACC, 'ch1');
      expect(out).toBeUndefined(); // caller keeps the save it already had
    });

    // ── purchaseStaminaHandler ──────────────────────────────────────────────────────────────────
    it('purchase of an amount other than 60 is refused (the route schema rejects it first over HTTP)', async () => {
      const { sent, reply } = makeReply();
      await purchaseStaminaHandler(deps(m.collections), req({ amount: 30 }), reply);
      expect(sent.code).toBe(400);
      expect((sent.payload as { error: { message: string } }).error.message).toBe('amount must be 60');
    });

    it('purchase when the stamina document reads back as missing: falls back to a full bar, capped, timer off', async () => {
      const { sent, reply } = makeReply();
      const out = (await purchaseStaminaHandler(deps(colsWithStamina({ findOne: async () => null })), req({ amount: 60 }), reply)) as {
        data: { stamina: { current: number; regenAt: number } };
      };
      expect(sent.code).toBeUndefined();
      expect(out.data.stamina).toEqual({ current: STAMINA_CAP, regenAt: 0 });
    });

    it('purchase against a half-written document (current only, no regenAt) starts a fresh regen timer', async () => {
      const cols = colsWithStamina({ findOne: async () => ({ _id: ACC, current: 10 }) });
      const { sent, reply } = makeReply();
      const out = (await purchaseStaminaHandler(deps(cols), req({ amount: 60 }), reply)) as {
        data: { stamina: { current: number; regenAt: number } };
      };
      expect(sent.code).toBeUndefined();
      expect(out.data.stamina).toEqual({ current: 70, regenAt: NOW + STAMINA_REGEN_MS });
    });
  });
});
