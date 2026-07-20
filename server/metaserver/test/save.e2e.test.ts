// save-service end-to-end (S0-7 acceptance): auth → JWT → GET/PUT save → optimistic lock 409 → concurrent writes → hard wall.
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
  } catch {
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
    const { token, accountId } = await authDevice('device-2');
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
  });

  it('PUT /save optimistic lock: If-Match hit writes rev+1, stale rev → 409 + current server value', async () => {
    const { token } = await authDevice('device-3');
    const auth = { authorization: `Bearer ${token}` };
    // Account creation already wrote the starter roster → base rev is 1 (see GET /save test above).

    const ok = await app.inject({
      method: 'PUT',
      url: '/save',
      headers: { ...auth, 'if-match': '1' },
      // materials is a server-authoritative field (§8); PUT does not accept it → only flags are persisted.
      payload: { save: { flags: { seenIntro: true }, materials: { wood: 5 } } },
    });
    expect(ok.statusCode).toBe(200);
    const saved = body(ok).data.save;
    expect(saved.rev).toBe(2);
    expect(saved.flags.seenIntro).toBe(true);
    expect(saved.materials.wood).toBeUndefined(); // server-authoritative; not overwritten by PUT

    const stale = await app.inject({
      method: 'PUT',
      url: '/save',
      headers: { ...auth, 'if-match': '1' },
      payload: { save: { flags: { x: true } } },
    });
    expect(stale.statusCode).toBe(409);
    const c = body(stale);
    expect(c.error.code).toBe('REV_CONFLICT');
    expect(c.save.rev).toBe(2);
  });

  it('concurrent PUTs with same rev → exactly one 200, one 409', async () => {
    const { token } = await authDevice('device-4');
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({
      method: 'PUT',
      url: '/save',
      headers: { ...auth, 'if-match': '0' },
      payload: { save: { flags: { init: true } } },
    });
    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'PUT',
        url: '/save',
        headers: { ...auth, 'if-match': '1' },
        payload: { save: { flags: { a: true } } },
      }),
      app.inject({
        method: 'PUT',
        url: '/save',
        headers: { ...auth, 'if-match': '1' },
        payload: { save: { flags: { b: true } } },
      }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
  });

  it('hard wall: PUT carrying authoritative fields (wallet/materials/progress) are ignored', async () => {
    const { token } = await authDevice('device-5');
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({
      method: 'PUT',
      url: '/save',
      headers: { ...auth, 'if-match': '1' }, // base rev 1 after starter-roster grant on account creation
      // SyncPatch only accepts equipped/flags → all other fields are discarded even if the client injects them (§8)
      payload: {
        save: {
          flags: { c: true },
          wallet: { coins: 999999 },
          materials: { scrap: 999 },
          progress: { cleared: ['ch_stress'], stars: {}, best: {} },
        },
      },
    });
    const r = await app.inject({
      method: 'GET',
      url: '/save',
      headers: auth,
    });
    const save = body(r).data.save;
    expect(save.wallet.coins).toBe(0);
    expect(save.materials).toEqual({});
    expect(save.progress.cleared).toEqual([]);
    expect(save.flags.c).toBe(true); // legitimate sync field written as expected
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
    expect(aList[0].roomId).toBe('HIST1');
    expect(aList[0].mode).toBe('ranked');
    expect(aList[0].result).toBe('win');
    expect(aList[0].eloDelta).toBe(16);
    expect(typeof aList[0].opponentPublicId).toBe('string');

    // Loser b's perspective: loss + eloDelta -16.
    const rb = await app.inject({
      method: 'GET', url: '/match/history', headers: { authorization: `Bearer ${b.token}` },
    });
    const bList = body(rb).data.matches as Array<Record<string, unknown>>;
    expect(bList[0].result).toBe('loss');
    expect(bList[0].eloDelta).toBe(-16);
  });
});
