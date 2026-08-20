// save-service end-to-end (S0-7 acceptance): auth → JWT → GET /save. PUT /save (the old generic
// client-sync endpoint) has been removed — equipped/flags mutation + optimistic-lock/concurrency
// coverage now lives in liveops-equip.test.ts and mutateSave's own retry loop (server/metaserver/src/
// service/base.ts), neither of which needs Mongo.
// Requires a real Mongo single-node replica set: `cd server && docker compose up -d`.
// Entire suite is skipped when Mongo is unreachable (does not block CI without a DB); prints a warning.
// Imports from the build artifact dist (NodeNext .js extensions are awkward under vitest source resolution); run `tsc -b` first.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, compressReplayDoc, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_test';
const jwt: JwtConfig = { secret: 'test-secret' };

// Short-timeout probe: skip the entire suite if unreachable.
async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[save.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

describe.skipIf(!mongo)('metaserver save-service e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'test-internal-key' });
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  const body = (r: { payload: string }) => JSON.parse(r.payload);

  async function authDevice(deviceId: string) {
    const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } });
    return body(r).data as { token: string; accountId: string; isNew: boolean };
  }

  it('auth/device: first time isNew, same deviceId consistently returns same accountId', async () => {
    const a1 = await authDevice('device-1');
    expect(a1.token).toBeTruthy();
    expect(a1.isNew).toBe(true);
    const a2 = await authDevice('device-1');
    expect(a2.accountId).toBe(a1.accountId);
    expect(a2.isNew).toBe(false);
  });

  it('GET /save without token → 401 UNAUTHENTICATED', async () => {
    const r = await app.inject({ method: 'GET', url: '/save' });
    expect(r.statusCode).toBe(401);
    expect(body(r).error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /save with token → auto-creates new save rev 1 (starter roster grant), coins 0', async () => {
    // Starter cards are actually granted inside /auth/device itself (maybeGrantStarterCards), not by this
    // GET — capture the provenance window around authDevice(), not around the read.
    const before = Date.now();
    const { token, accountId } = await authDevice('device-2');
    const after = Date.now();
    const r = await app.inject({
      method: 'GET',
      url: '/save',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    const save = body(r).data.save;
    expect(save.rev).toBe(1); // account creation grants the starter card roster (CC-2) → one write → fresh save is rev 1
    expect(save.accountId).toBe(accountId);
    expect(save.wallet.coins).toBe(0);
    // Provenance (ITEM_IDENTITY_DESIGN.md, 2026-08-04): the 3 starter cards are tagged sourceType='starter'.
    const starterCards: Array<{ sourceType?: string; obtainedAt?: number }> = Object.values(save.cardInv);
    expect(starterCards).toHaveLength(3);
    for (const c of starterCards) {
      expect(c.sourceType).toBe('starter');
      expect(c.obtainedAt).toBeGreaterThanOrEqual(before);
      expect(c.obtainedAt).toBeLessThanOrEqual(after);
    }
  });

  it('concurrent flag writes with the same starting rev → both eventually apply (mutateSave retries internally, no client-visible conflict)', async () => {
    const { token } = await authDevice('device-4');
    const auth = { authorization: `Bearer ${token}` };
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'PUT', url: '/flags', headers: auth, payload: { key: 'a', value: true } }),
      app.inject({ method: 'PUT', url: '/flags', headers: auth, payload: { key: 'b', value: true } }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const r = await app.inject({ method: 'GET', url: '/save', headers: auth });
    const save = body(r).data.save;
    expect(save.flags.a).toBe(true);
    expect(save.flags.b).toBe(true);
  });

  // ── Match history (archive enrich + GET /match/history) ─────────────────────────────
  it('GET /match/history without token → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/match/history' });
    expect(r.statusCode).toBe(401);
  });

  it('GET /match/history with no matches → empty array', async () => {
    const { token } = await authDevice('hist-empty');
    const r = await app.inject({
      method: 'GET',
      url: '/match/history',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    expect(body(r).data.matches).toEqual([]);
  });

  it('after ranked report both players get their match record: result + opponent publicId snapshot + eloDelta', async () => {
    const a = await authDevice('hist-aaaa');
    const b = await authDevice('hist-bbbb');
    // Ranked settlement requires both players to have an existing save (getOrCreateSave); fetch once each to create them.
    await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${a.token}` } });
    await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${b.token}` } });
    // Internal report: settle ELO + enrich players (display name / publicId snapshot + eloDelta) + archive.
    const report = await app.inject({
      method: 'POST',
      url: '/internal/match/report',
      headers: { 'x-internal-key': 'test-internal-key' },
      payload: {
        room_id: 'HIST1', seed: '7', mode: 'ranked', reason: 'base', winner_side: 0, hash_ok: true,
        players: [
          { side: 0, accountId: a.accountId },
          { side: 1, accountId: b.accountId },
        ],
        results: [
          { side: 0, state_hash: 'H', winner_side: 0 },
          { side: 1, state_hash: 'H', winner_side: 0 },
        ],
        replay_gz: compressReplayDoc({ engineVersion: 0, mode: 'netplay', seed: '7', endFrame: 0, frames: [], meta: { recordedAt: 0, winner: 0 } }).toString('base64'),
      },
    });
    expect(report.statusCode).toBe(200);

    // Winner a's perspective: win + eloDelta +16 + opponent publicId snapshot.
    const ra = await app.inject({
      method: 'GET', url: '/match/history', headers: { authorization: `Bearer ${a.token}` },
    });
    expect(ra.statusCode).toBe(200);
    const aList = body(ra).data.matches as Array<Record<string, unknown>>;
    expect(aList).toHaveLength(1);
    expect(aList[0]!.roomId).toBe('HIST1');
    expect(aList[0]!.mode).toBe('ranked');
    expect(aList[0]!.result).toBe('win');
    expect(aList[0]!.eloDelta).toBe(16);
    expect(typeof aList[0]!.opponentPublicId).toBe('string');

    // Loser b's perspective: loss + eloDelta -16.
    const rb = await app.inject({
      method: 'GET', url: '/match/history', headers: { authorization: `Bearer ${b.token}` },
    });
    const bList = body(rb).data.matches as Array<Record<string, unknown>>;
    expect(bList[0]!.result).toBe('loss');
    expect(bList[0]!.eloDelta).toBe(-16);
  });
});
