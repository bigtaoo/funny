// Match replay fetch end-to-end (S1-RP): /internal/match/report archives the replay → GET /match/{roomId}/replay.
//   Participants can retrieve it (two paths: inline or external replayRef), non-participants get 404, missing match gets 404.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_replay_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const KEY = 'k';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[match-replay.e2e] Mongo unreachable (${URI}) — skipping.`);

function reportPayload(roomId: string, a: string, b: string, frames: unknown[]) {
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
    replay: { engineVersion: 0, mode: 'netplay', seed: '42', endFrame: 3, frames, meta: { recordedAt: 1, winner: 0 } },
  };
}

describe.skipIf(!mongo)('match replay fetch e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let tokenA: string, idA: string, idB: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
    const ra = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'rep-aaaa-1' } }));
    const rb = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'rep-bbbb-1' } }));
    tokenA = ra.data.token; idA = ra.data.accountId; idB = rb.data.accountId;
  });

  afterAll(async () => { if (app) await app.close(); });

  const oneFrame = [{ frame: 3, cmds: [{ side: 0, commands: 'AAA=' }] }];

  it('participant retrieves inline replay', async () => {
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('RR1', idA, idB, oneFrame) });
    const res = await app.inject({ method: 'GET', url: '/match/RR1/replay', headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    const r = body(res);
    expect(r.data.replay.endFrame).toBe(3);
    expect(r.data.replay.frames[0].cmds[0].commands).toBe('AAA=');
  });

  it('non-participant gets 404', async () => {
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('RR2', idA, idB, oneFrame) });
    const rc = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'rep-cccc-1' } }));
    const res = await app.inject({ method: 'GET', url: '/match/RR2/replay', headers: { authorization: `Bearer ${rc.data.token}` } });
    expect(res.statusCode).toBe(404);
  });

  it('non-existent match gets 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/match/NOPE/replay', headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(404);
  });

  it('large match stored in replayBlobs (replayRef) is still retrievable', async () => {
    // Build a frame log exceeding the inline threshold (256KB) → archived to replayBlobs + replayRef.
    const big = 'A'.repeat(400 * 1024);
    const bigFrames = [{ frame: 3, cmds: [{ side: 0, commands: big }] }];
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('RR3', idA, idB, bigFrames) });
    // The matches document should have only replayRef, no inline replay; the blob collection holds the match.
    const doc = await m.collections.matches.findOne({ roomId: 'RR3' });
    expect(doc!.replayRef).toBe('RR3');
    expect(doc!.replay).toBeUndefined();
    const res = await app.inject({ method: 'GET', url: '/match/RR3/replay', headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    expect(body(res).data.replay.frames[0].cmds[0].commands.length).toBe(400 * 1024);
  });
});
