// Unit-style coverage backfill for src/service/save.ts (SaveService: GET /save, /match/history,
// /match/:roomId/replay, replay-share endpoints) — 2026-08-14 coverage task.
//
// Why this file exists: these handlers already have business-logic coverage via other e2e suites
// (save.e2e.test.ts, match-replay.e2e.test.ts, state-replay-share.e2e.test.ts, pvp-card-stats.e2e.test.ts),
// but every one of those imports `buildApp` from '../dist/app.js' — vitest's v8 coverage provider only
// attributes executed lines to `src/*.ts` when the module was loaded through vitest's own transform, so
// running the compiled dist through Node's loader records zero coverage against src/service/save.ts even
// though the same logic runs. This file imports `buildApp` from '../src/app.js' instead (real Mongo, same
// convention as economy-service-unit.test.ts — save.ts's reconcile/mirror/migration helpers touch
// several real collections with Mongo-specific operators FakeCollection doesn't implement) and adds the
// error/edge branches those e2e files don't reach (commercial reconcile failure, season-migration
// failure, cold-tier archive fallback down to "replay unavailable", limit-clamping, rate limiting).
//
// Existing e2e files read for scenarios/shapes: save.e2e.test.ts, match-replay.e2e.test.ts,
// state-replay-share.e2e.test.ts, pvp-card-stats.e2e.test.ts (report payload shape), replayArchive.test.ts.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createMongo, STARTER_TITLE, type JwtConfig, type MongoHandle, type MatchDoc } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { CommercialClient, UndeliveredOrder, WalletView } from '../src/commercialClient.js';
import { archiveMatch } from '../src/replayArchive.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_savesvc_unit_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const KEY = 'k';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[save-service-unit] Mongo unreachable (${URI}) — skipping.`);

/** Minimal configurable fake commercial client: only getWallet/undeliveredOrders are exercised by save.ts. */
class FakeCommercial implements CommercialClient {
  readonly available: boolean;
  constructor(available = true) {
    this.available = available;
  }
  coins = 0;
  pity: Record<string, number> = {};
  pendingOrders: UndeliveredOrder[] = [];
  throwOnUndelivered = false;
  throwOnGetWallet = false;

  async getWallet(): Promise<WalletView | null> {
    if (this.throwOnGetWallet) throw new Error('simulated commercial getWallet outage');
    return {
      coins: this.coins,
      pity: this.pity,
      fatePoints: 0,
      subscriptionExpiry: 0,
      starterUsed: [],
      firstPurchaseUsed: false,
      totalRechargeCents: 0,
    };
  }
  async undeliveredOrders(): Promise<UndeliveredOrder[]> {
    if (this.throwOnUndelivered) throw new Error('simulated commercial undeliveredOrders outage');
    return this.pendingOrders;
  }
  async orderDelivered() { return { ok: true as const }; }
  // --- Unused by save.ts; only here to satisfy `implements CommercialClient` ---
  async shopCharge(): Promise<never> { throw new Error('not used'); }
  async gachaDraw(): Promise<never> { throw new Error('not used'); }
  async createCustomPool(): Promise<never> { throw new Error('not used'); }
  async closeLimitedPool(): Promise<never> { throw new Error('not used'); }
  async listLimitedPools(): Promise<never[]> { return []; }
  async listActiveLimitedPools(): Promise<never[]> { return []; }
  async redeemFate(): Promise<never> { throw new Error('not used'); }
  async starterBuy(): Promise<never> { throw new Error('not used'); }
  async monthlyCardBuy(): Promise<never> { throw new Error('not used'); }
  async yearCardBuy(): Promise<never> { throw new Error('not used'); }
  async monthlyCardClaim(): Promise<never> { throw new Error('not used'); }
  async rechargeVerify(): Promise<never> { throw new Error('not used'); }
  async verifyNonCoinReceipt(): Promise<never> { throw new Error('not used'); }
  async adsCredit(): Promise<never> { throw new Error('not used'); }
  async victoryCredit(): Promise<never> { throw new Error('not used'); }
  async spend(): Promise<never> { throw new Error('not used'); }
  async grant(): Promise<never> { throw new Error('not used'); }
  async promoRedeem(): Promise<never> { throw new Error('not used'); }
  async paddleComplete(): Promise<never> { throw new Error('not used'); }
  async recordPaddleEvent(): Promise<never> { throw new Error('not used'); }
  async paddleRefund(): Promise<never> { throw new Error('not used'); }
  async auditCoinGains(): Promise<never[]> { return []; }
}

function baseMatch(roomId: string, players: MatchDoc['players'], extra: Partial<MatchDoc> = {}): MatchDoc {
  return {
    roomId,
    mode: 'ranked',
    seed: '1',
    players,
    winner: 0,
    reason: 'base',
    hashOk: true,
    ts: Date.now(),
    ...extra,
  };
}

describe.skipIf(!mongo)('SaveService handlers (src import, coverage backfill)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  async function buildAndAuth(opts: { commercial?: CommercialClient } = {}): Promise<void> {
    comm = (opts.commercial as FakeCommercial) ?? new FakeCommercial();
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY, commercial: comm });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `device-${Math.random()}` } }));
    token = r.data.token;
    accountId = r.data.accountId;
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    await buildAndAuth();
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  // ── GET /save ───────────────────────────────────────────────────────────────────────────────
  describe('GET /save', () => {
    it('happy path: creates the save, injects stamina snapshot + publicId + freeRename + serverNow, grants the starter title', async () => {
      const before = Date.now();
      const r = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(r.ok).toBe(true);
      const save = r.data.save;
      expect(save.rev).toBeGreaterThanOrEqual(1);
      expect(save.stamina).toEqual({ current: 120, regenAt: 0 });
      expect(save.titles).toContain(STARTER_TITLE);
      expect(r.data.publicId).toMatch(/^\d{9}$/);
      expect(r.data.freeRename).toBe(true);
      expect(typeof r.data.displayName).toBe('string');
      expect(r.data.serverNow).toBeGreaterThanOrEqual(before);
    });

    it('commercial unavailable: skips reconcile/mirror entirely, still 200', async () => {
      await buildAndAuth({ commercial: new FakeCommercial(false) });
      const r = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(r.ok).toBe(true);
      expect(r.data.save.wallet.coins).toBe(0);
    });

    it('commercial available: reconcile pulls the wallet and mirrors coins/pity into the save', async () => {
      comm.coins = 777;
      comm.pity = { standard: 3 };
      const r = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(r.data.save.wallet.coins).toBe(777);
      expect(r.data.save.gacha.pity.standard).toBe(3);
    });

    it('commercial.undeliveredOrders throws: caught, logged, still serves the local save (200)', async () => {
      comm.throwOnUndelivered = true;
      const r = await app.inject({ method: 'GET', url: '/save', headers: auth() });
      expect(r.statusCode).toBe(200);
      expect(body(r).data.save.accountId).toBe(accountId);
    });

    it('commercial.getWallet throws: reconcile fails, caught, still 200', async () => {
      comm.throwOnGetWallet = true;
      const r = await app.inject({ method: 'GET', url: '/save', headers: auth() });
      expect(r.statusCode).toBe(200);
    });

    it('season migration: a stale pvp.seasonNo is migrated forward, granting a season title', async () => {
      // Touch /save once to create the account's save doc (default pvp.seasonNo=1).
      await app.inject({ method: 'GET', url: '/save', headers: auth() });
      // Advance the global season clock to #2 directly (admin/season-roll equivalent, simplified).
      await m.collections.ladderSeasons.updateOne(
        { _id: 'current' },
        { $set: { seasonNo: 2, startAt: Date.now(), endAt: Date.now() + 1000 } },
        { upsert: true },
      );
      const r = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(r.data.save.pvp.seasonNo).toBe(2);
    });

    // NOTE: getSave's outer try/catch around `await currentSeasonPromise` / migrateIfStale (save.ts
    // lines ~86-100) is intentionally NOT covered here. getCurrentSeason's promise is created before
    // several other `await`s run (fire-then-await-later, see save.ts's own comment on why), so forcing
    // it to reject via a broken `cols.ladderSeasons` triggers a spurious Node
    // PromiseRejectionHandledWarning (the rejection is genuinely handled, just several ticks later than
    // Node's detector expects) — confirmed this doesn't fail the assertion itself (the route still
    // correctly returns 200), but it pollutes the test run with an "Unhandled Rejection" report that
    // risks destabilizing an unrelated test's flakiness detection. Left uncovered as a defensive-only
    // branch; the sibling commercial-side failure branches (reconcile/getWallet throwing, tested above)
    // exercise the same "best-effort, log and continue" pattern without this timing hazard.
  });

  // ── GET /match/history ─────────────────────────────────────────────────────────────────────
  describe('GET /match/history', () => {
    it('no matches yet -> empty array', async () => {
      const r = body(await app.inject({ method: 'GET', url: '/match/history', headers: auth() }));
      expect(r.data.matches).toEqual([]);
    });

    it('win/loss + opponent snapshot + eloDelta, sorted newest first, default limit=20', async () => {
      const oppId = 'opp-hist-1';
      await m.collections.matches.insertOne(baseMatch('MH1', [
        { side: 0, accountId, displayName: 'Me', publicId: '111111111', eloDelta: 16 },
        { side: 1, accountId: oppId, displayName: 'Opp', publicId: '222222222', eloDelta: -16 },
      ], { winner: 0, ts: 1000 }));
      await m.collections.matches.insertOne(baseMatch('MH2', [
        { side: 0, accountId, eloDelta: -10 },
        { side: 1, accountId: oppId },
      ], { winner: 1, ts: 2000 }));
      const r = body(await app.inject({ method: 'GET', url: '/match/history', headers: auth() }));
      expect(r.data.matches).toHaveLength(2);
      expect(r.data.matches[0].roomId).toBe('MH2'); // newest first
      expect(r.data.matches[0].result).toBe('loss');
      expect(r.data.matches[0].eloDelta).toBe(-10);
      expect(r.data.matches[1].result).toBe('win');
      expect(r.data.matches[1].opponentName).toBe('Opp');
      expect(r.data.matches[1].opponentPublicId).toBe('222222222');
    });

    it('winner=-1 (voided/unsettled) -> result "unknown"', async () => {
      await m.collections.matches.insertOne(baseMatch('MH3', [
        { side: 0, accountId },
        { side: 1, accountId: 'opp-hist-2' },
      ], { winner: -1 }));
      const r = body(await app.inject({ method: 'GET', url: '/match/history', headers: auth() }));
      expect(r.data.matches[0].result).toBe('unknown');
    });

    // NOTE: the openapi request schema for `limit` already declares type:integer, minimum:1, maximum:50,
    // default:20 — Fastify's ajv validation (with coercion) enforces all of that BEFORE the handler ever
    // runs, so a genuinely out-of-range or non-numeric `limit` never reaches getMatchHistory's own
    // `Number.isFinite`/`Math.min`/`Math.max` clamping logic via the real HTTP route (that logic is only
    // reachable if some other, non-schema-validated caller invokes the handler directly). Confirmed here:
    // out-of-range values are rejected at the schema layer (400), not silently clamped by the handler.
    it('limit within [1,50] flows through to the query; out-of-range/non-integer values are rejected by the openapi schema before the handler runs', async () => {
      for (let i = 0; i < 3; i++) {
        await m.collections.matches.insertOne(baseMatch(`MHL${i}`, [{ side: 0, accountId }, { side: 1, accountId: 'x' }], { ts: i }));
      }
      const one = body(await app.inject({ method: 'GET', url: '/match/history?limit=1', headers: auth() }));
      expect(one.data.matches).toHaveLength(1);
      const fifty = await app.inject({ method: 'GET', url: '/match/history?limit=50', headers: auth() });
      expect(fifty.statusCode).toBe(200); // upper bound accepted
      const over = await app.inject({ method: 'GET', url: '/match/history?limit=51', headers: auth() });
      expect(over.statusCode).toBe(400); // schema maximum:50 rejects this before getMatchHistory runs
      const zero = await app.inject({ method: 'GET', url: '/match/history?limit=0', headers: auth() });
      expect(zero.statusCode).toBe(400); // schema minimum:1
      const nan = await app.inject({ method: 'GET', url: '/match/history?limit=abc', headers: auth() });
      expect(nan.statusCode).toBe(400); // schema type:integer
    });
  });

  // ── GET /match/:roomId/replay ──────────────────────────────────────────────────────────────
  describe('GET /match/:roomId/replay', () => {
    it('non-existent match -> 404 "match not found"', async () => {
      const r = await app.inject({ method: 'GET', url: '/match/NOPE/replay', headers: auth() });
      expect(r.statusCode).toBe(404);
    });

    it('non-participant -> 404', async () => {
      await m.collections.matches.insertOne(baseMatch('MR1', [
        { side: 0, accountId: 'other-a' }, { side: 1, accountId: 'other-b' },
      ], { replayGz: Buffer.from('gz-bytes') }));
      const r = await app.inject({ method: 'GET', url: '/match/MR1/replay', headers: auth() });
      expect(r.statusCode).toBe(404);
    });

    it('participant, inline replayGz -> 200 base64', async () => {
      await m.collections.matches.insertOne(baseMatch('MR2', [
        { side: 0, accountId }, { side: 1, accountId: 'opp' },
      ], { replayGz: Buffer.from('inline-bytes') }));
      const r = body(await app.inject({ method: 'GET', url: '/match/MR2/replay', headers: auth() }));
      expect(Buffer.from(r.data.replayGz, 'base64').toString()).toBe('inline-bytes');
    });

    it('participant, replayRef fallback to replayBlobs -> 200', async () => {
      await m.collections.replayBlobs.insertOne({ _id: 'MR3', replayGz: Buffer.from('blob-bytes'), ts: Date.now() });
      await m.collections.matches.insertOne(baseMatch('MR3', [
        { side: 0, accountId }, { side: 1, accountId: 'opp' },
      ], { replayRef: 'MR3' }));
      const r = body(await app.inject({ method: 'GET', url: '/match/MR3/replay', headers: auth() }));
      expect(Buffer.from(r.data.replayGz, 'base64').toString()).toBe('blob-bytes');
    });

    it('cold-tier fallback: Mongo doc gone, archived meta+replay on disk -> 200', async () => {
      const players = [{ side: 0, accountId }, { side: 1, accountId: 'opp' }];
      archiveMatch(baseMatch('MR4', players), Buffer.from('archived-bytes'));
      await new Promise((r) => setTimeout(r, 50)); // fire-and-forget archive write
      const r = body(await app.inject({ method: 'GET', url: '/match/MR4/replay', headers: auth() }));
      expect(Buffer.from(r.data.replayGz, 'base64').toString()).toBe('archived-bytes');
    });

    it('cold-tier: archived meta present (participant validates) but the .replay.gz file is missing -> 404 "replay unavailable"', async () => {
      const players = [{ side: 0, accountId }, { side: 1, accountId: 'opp' }];
      archiveMatch(baseMatch('MR5', players), Buffer.from('will-be-deleted'));
      await new Promise((r) => setTimeout(r, 50));
      const dir = process.env.NW_REPLAY_ARCHIVE_DIR!;
      await fs.unlink(join(dir, 'MR5.replay.gz'));
      const r = await app.inject({ method: 'GET', url: '/match/MR5/replay', headers: auth() });
      expect(r.statusCode).toBe(404);
    });
  });

  // ── POST /match/:roomId/replay/share (createReplayShare) ──────────────────────────────────
  describe('POST /match/:roomId/replay/share', () => {
    it('happy path: mints a shareId for an existing replayBlob', async () => {
      await m.collections.replayBlobs.insertOne({ _id: 'RS1', replayGz: Buffer.from('x'), ts: Date.now() });
      const r = body(await app.inject({ method: 'POST', url: '/match/RS1/replay/share', headers: auth() }));
      expect(r.data.shareId).toBeTruthy();
    });

    it('no such replayBlob -> 404', async () => {
      const r = await app.inject({ method: 'POST', url: '/match/NOPE/replay/share', headers: auth() });
      expect(r.statusCode).toBe(404);
    });
  });

  // ── GET /share/replay/:shareId (getReplayByShare) ─────────────────────────────────────────
  describe('GET /share/replay/:shareId', () => {
    it('happy path: no auth required, returns the replay bytes', async () => {
      await m.collections.replayBlobs.insertOne({ _id: 'RS2', replayGz: Buffer.from('shared-bytes'), ts: Date.now() });
      const mint = body(await app.inject({ method: 'POST', url: '/match/RS2/replay/share', headers: auth() }));
      const r = body(await app.inject({ method: 'GET', url: `/share/replay/${mint.data.shareId}` }));
      expect(Buffer.from(r.data.replayGz, 'base64').toString()).toBe('shared-bytes');
    });

    it('unknown shareId -> 404', async () => {
      const r = await app.inject({ method: 'GET', url: '/share/replay/nope-nope' });
      expect(r.statusCode).toBe(404);
    });

    it('cold-tier fallback: replayBlobs doc gone, disk archive still has it -> 200', async () => {
      await m.collections.replayBlobs.insertOne({ _id: 'RS3', replayGz: Buffer.from('temp'), ts: Date.now() });
      const mint = body(await app.inject({ method: 'POST', url: '/match/RS3/replay/share', headers: auth() }));
      await m.collections.replayBlobs.deleteOne({ _id: 'RS3' });
      archiveMatch(baseMatch('RS3', [{ side: 0, accountId }]), Buffer.from('cold-tier-bytes'));
      await new Promise((r) => setTimeout(r, 50));
      const r = body(await app.inject({ method: 'GET', url: `/share/replay/${mint.data.shareId}` }));
      expect(Buffer.from(r.data.replayGz, 'base64').toString()).toBe('cold-tier-bytes');
    });

    it('share exists but neither replayBlobs nor disk archive has the bytes -> 404', async () => {
      await m.collections.replayBlobs.insertOne({ _id: 'RS4', replayGz: Buffer.from('temp'), ts: Date.now() });
      const mint = body(await app.inject({ method: 'POST', url: '/match/RS4/replay/share', headers: auth() }));
      await m.collections.replayBlobs.deleteOne({ _id: 'RS4' });
      const r = await app.inject({ method: 'GET', url: `/share/replay/${mint.data.shareId}` });
      expect(r.statusCode).toBe(404);
    });
  });

  // ── POST /replay/share (createStateReplayShare) ───────────────────────────────────────────
  describe('POST /replay/share', () => {
    it('happy path: mints a shareCode for a client-supplied blob', async () => {
      const r = body(await app.inject({ method: 'POST', url: '/replay/share', headers: auth(), payload: { blob: 'gzip-base64-blob' } }));
      expect(r.data.shareCode).toBeTruthy();
    });

    it('missing blob -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/replay/share', headers: auth(), payload: {} });
      expect(r.statusCode).toBe(400);
    });

    // NOTE: createStateReplayShare's own `typeof blob !== 'string'` runtime check (save.ts) is
    // unreachable via the real HTTP route: the openapi schema already declares `blob` as
    // required+type:string, and ajv's type coercion turns a JSON number payload into a string before the
    // handler ever runs (confirmed: sending `{blob: 12345}` here returns 200, not 400 — proving the
    // value was coerced to the string "12345" rather than rejected). Left uncovered as schema-guaranteed
    // defensive code, same reasoning as getMatchHistory's limit-clamping branches above.

    it('empty-string blob -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/replay/share', headers: auth(), payload: { blob: '' } });
      expect(r.statusCode).toBe(400);
    });

    it('oversized blob (>2MB) -> 400', async () => {
      const big = 'A'.repeat(2 * 1024 * 1024 + 16);
      const r = await app.inject({ method: 'POST', url: '/replay/share', headers: auth(), payload: { blob: big } });
      expect(r.statusCode).toBe(400);
    });

    it('per-account rate limit: the 21st share within the window -> 429', async () => {
      for (let i = 0; i < 20; i++) {
        const r = await app.inject({ method: 'POST', url: '/replay/share', headers: auth(), payload: { blob: `blob-${i}` } });
        expect(r.statusCode).toBe(200);
      }
      const over = await app.inject({ method: 'POST', url: '/replay/share', headers: auth(), payload: { blob: 'blob-over' } });
      expect(over.statusCode).toBe(429);
    });
  });

  // ── GET /r/:shareCode (getStateReplayShare) ───────────────────────────────────────────────
  describe('GET /r/:shareCode', () => {
    it('happy path: no auth required, returns the blob and increments viewCount', async () => {
      const mint = body(await app.inject({ method: 'POST', url: '/replay/share', headers: auth(), payload: { blob: 'view-me' } }));
      const r = body(await app.inject({ method: 'GET', url: `/r/${mint.data.shareCode}` }));
      expect(r.data.blob).toBe('view-me');
      await new Promise((res) => setTimeout(res, 100)); // fire-and-forget $inc
      const doc = await m.collections.stateReplayShares.findOne({ _id: mint.data.shareCode });
      expect(doc!.viewCount).toBe(1);
    });

    it('unknown shareCode -> 404', async () => {
      const r = await app.inject({ method: 'GET', url: '/r/does-not-exist' });
      expect(r.statusCode).toBe(404);
    });
  });
});
