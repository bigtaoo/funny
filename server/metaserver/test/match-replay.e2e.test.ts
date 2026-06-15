// 对局录像取回端到端（S1-RP）：/internal/match/report 归档录像 → GET /match/{roomId}/replay。
//   参与者可取回（内嵌 / replayRef 外置两路径）、非参与者 404、缺失 404。
// 需 `cd server && docker compose up -d` + 先 `tsc -b`（导入 dist）。
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
if (!mongo) console.warn(`[match-replay.e2e] Mongo 不可达（${URI}）— 跳过。`);

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

  it('参与者取回内嵌录像', async () => {
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('RR1', idA, idB, oneFrame) });
    const res = await app.inject({ method: 'GET', url: '/match/RR1/replay', headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    const r = body(res);
    expect(r.data.replay.endFrame).toBe(3);
    expect(r.data.replay.frames[0].cmds[0].commands).toBe('AAA=');
  });

  it('非参与者 404', async () => {
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('RR2', idA, idB, oneFrame) });
    const rc = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'rep-cccc-1' } }));
    const res = await app.inject({ method: 'GET', url: '/match/RR2/replay', headers: { authorization: `Bearer ${rc.data.token}` } });
    expect(res.statusCode).toBe(404);
  });

  it('不存在的对局 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/match/NOPE/replay', headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(404);
  });

  it('大局走 replayBlobs（replayRef）也能取回', async () => {
    // 造一个超过内嵌阈值（256KB）的帧日志 → 归档落 replayBlobs + replayRef。
    const big = 'A'.repeat(400 * 1024);
    const bigFrames = [{ frame: 3, cmds: [{ side: 0, commands: big }] }];
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('RR3', idA, idB, bigFrames) });
    // matches 文档应只有 replayRef，无内嵌 replay；blob 集合有该局。
    const doc = await m.collections.matches.findOne({ roomId: 'RR3' });
    expect(doc!.replayRef).toBe('RR3');
    expect(doc!.replay).toBeUndefined();
    const res = await app.inject({ method: 'GET', url: '/match/RR3/replay', headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    expect(body(res).data.replay.frames[0].cmds[0].commands.length).toBe(400 * 1024);
  });
});
