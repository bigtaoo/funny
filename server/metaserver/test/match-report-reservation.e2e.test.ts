// Settlement reservation guard (comm-audit-internal-2026-07-28 P0-1): /internal/match/report
// used to be read-check → settle → insertOne, so a gameserver retry racing an in-flight first
// settlement double-credited ELO/coins (the unique roomId index only stopped the archive write).
// These tests pin the new atomic-reservation behavior: duplicates dedup, in-flight reservations
// short-circuit, stale reservations get taken over, and settlement side effects apply exactly once.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, compressReplayDoc, type JwtConfig, type MongoHandle, type MatchReplayDoc } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_report_reservation_test';
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
if (!mongo) console.warn(`[match-report-reservation.e2e] Mongo unreachable (${URI}) — skipping.`);

function reportPayload(roomId: string, a: string, b: string) {
  const replayDoc: MatchReplayDoc = {
    engineVersion: 0,
    mode: 'netplay',
    seed: '42',
    endFrame: 3,
    frames: [{ frame: 3, cmds: [{ side: 0, commands: 'AAA=' }] }],
    meta: { recordedAt: 1, winner: 0 },
  };
  return {
    room_id: roomId,
    seed: '42',
    mode: 'ranked',
    reason: 'base',
    winner_side: 0,
    hash_ok: true,
    players: [{ side: 0, accountId: a }, { side: 1, accountId: b }],
    results: [
      { side: 0, state_hash: 'H', winner_side: 0 },
      { side: 1, state_hash: 'H', winner_side: 0 },
    ],
    replay_gz: compressReplayDoc(replayDoc).toString('base64'),
  };
}

describe.skipIf(!mongo)('match report settlement reservation', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let idA: string, idB: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const report = (roomId: string) =>
    app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload(roomId, idA, idB) });
  const eloOf = async (accountId: string): Promise<number> => {
    const doc = await m.collections.saves.findOne({ _id: accountId });
    return doc?.save?.pvp?.elo ?? -1;
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
    const ra = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'res-aaaa-1' } }));
    const rb = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'res-bbbb-1' } }));
    idA = ra.data.accountId;
    idB = rb.data.accountId;
    // settleElo only settles accounts that already have a save doc — prime both via GET /save.
    const sa = await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${ra.data.token}` } });
    const sb = await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${rb.data.token}` } });
    if (sa.statusCode !== 200 || sb.statusCode !== 200) {
      throw new Error(`save priming failed: ${sa.statusCode}/${sb.statusCode} ${sa.payload.slice(0, 200)}`);
    }
    const savedCount = await m.collections.saves.countDocuments({});
    if (savedCount < 2) throw new Error(`expected 2 primed saves, got ${savedCount}; ids=${idA},${idB}`);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('normal report archives the real doc (no settling residue) and settles once', async () => {
    const r1 = await report('RES1');
    expect(r1.statusCode).toBe(200);
    const doc = await m.collections.matches.findOne({ roomId: 'RES1' });
    expect(doc).toBeTruthy();
    expect(doc!.mode).toBe('ranked');
    expect((doc as { settling?: boolean }).settling).toBeUndefined();
    const eloAfterFirst = await eloOf(idA);
    expect(eloAfterFirst).toBeGreaterThan(0);

    // Exact duplicate (gameserver retry after archive) → idempotent, no second credit.
    const r2 = await report('RES1');
    expect(r2.statusCode).toBe(200);
    expect(await eloOf(idA)).toBe(eloAfterFirst);
    expect(await m.collections.matches.countDocuments({ roomId: 'RES1' })).toBe(1);
  });

  it('report arriving while a fresh reservation is in flight dedups without settling', async () => {
    // Simulate another meta request mid-settlement: reservation placeholder, younger than takeover window.
    await m.collections.matches.insertOne({
      roomId: 'RES2',
      mode: '__settling__',
      seed: '42',
      players: [],
      winner: -1,
      reason: 'settling',
      hashOk: true,
      settling: true,
      settlingAt: Date.now(),
      ts: Date.now(),
    } as never);
    const before = await eloOf(idA);
    const res = await report('RES2');
    expect(res.statusCode).toBe(200);
    expect(body(res).ok).toBe(true);
    // Nothing settled, placeholder untouched (still owned by the in-flight request).
    expect(await eloOf(idA)).toBe(before);
    const doc = await m.collections.matches.findOne({ roomId: 'RES2' });
    expect((doc as { settling?: boolean }).settling).toBe(true);
  });

  it('report takes over a stale reservation (crashed settlement) and completes it', async () => {
    await m.collections.matches.insertOne({
      roomId: 'RES3',
      mode: '__settling__',
      seed: '42',
      players: [],
      winner: -1,
      reason: 'settling',
      hashOk: true,
      settling: true,
      settlingAt: Date.now() - 3 * 60_000, // older than MATCH_SETTLING_TAKEOVER_MS (2min)
      ts: Date.now() - 3 * 60_000,
    } as never);
    const res = await report('RES3');
    expect(res.statusCode).toBe(200);
    const doc = await m.collections.matches.findOne({ roomId: 'RES3' });
    expect(doc!.mode).toBe('ranked');
    expect((doc as { settling?: boolean }).settling).toBeUndefined();
    expect(await eloOf(idA)).toBeGreaterThan(0);
    expect(await m.collections.matches.countDocuments({ roomId: 'RES3' })).toBe(1);
  });
});
