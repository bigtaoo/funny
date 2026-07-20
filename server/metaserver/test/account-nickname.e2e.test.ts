// Default-nickname lazy backfill e2e: guest/device accounts never set a displayName at
// registration, so before this fix GET /save and match-history opponent lookups both fell back
// to a raw id forever. ensureDisplayName (accounts.ts) lazily assigns and persists a random
// default the first time it's read — this suite covers GET /save exposing it, idempotency across
// repeated reads, that an already-set name is never clobbered, and that match history's
// opponentName snapshot is populated for an opponent who never customized their nickname.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, compressReplayDoc, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_nickname_test';
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
if (!mongo) console.warn(`[account-nickname.e2e] Mongo unreachable (${URI}) — skipping.`);

function reportPayload(roomId: string, a: string, b: string) {
  return {
    room_id: roomId,
    seed: '1',
    mode: 'ranked',
    reason: 'base',
    winner_side: 0,
    hash_ok: true,
    players: [{ side: 0, accountId: a }, { side: 1, accountId: b }],
    results: [
      { side: 0, state_hash: 'H', winner_side: 0 },
      { side: 1, state_hash: 'H', winner_side: 0 },
    ],
    replay_gz: compressReplayDoc({ engineVersion: 0, mode: 'netplay', seed: '1', endFrame: 1, frames: [], meta: { recordedAt: 1, winner: 0 } }).toString('base64'),
  };
}

describe.skipIf(!mongo)('default nickname lazy backfill e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;

  const body = (r: { payload: string }) => JSON.parse(r.payload);

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
  });

  afterAll(async () => { if (app) await app.close(); });

  async function authDevice(deviceId: string) {
    const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } });
    return body(r).data as { token: string; accountId: string };
  }

  it('GET /save for a never-named guest account backfills a non-empty default displayName', async () => {
    const { token } = await authDevice('nickname-1');
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${token}` } }));
    expect(typeof save.data.displayName).toBe('string');
    expect(save.data.displayName.length).toBeGreaterThan(0);
  });

  it('repeated GET /save returns the same backfilled name (persisted, not regenerated per read)', async () => {
    const { token } = await authDevice('nickname-2');
    const first = body(await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${token}` } })).data.displayName;
    const second = body(await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${token}` } })).data.displayName;
    expect(second).toBe(first);
  });

  it('an already-set displayName is never overwritten by the lazy backfill', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'nick3@test.com', password: 'pw123456', displayName: 'CustomName' } });
    const { token } = body(r).data as { token: string };
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${token}` } }));
    expect(save.data.displayName).toBe('CustomName');
  });

  it('match history opponentName is populated for an opponent who never set a nickname', async () => {
    const a = await authDevice('nickname-4a');
    const b = await authDevice('nickname-4b');
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('NICK1', a.accountId, b.accountId) });
    const history = body(await app.inject({ method: 'GET', url: '/match/history', headers: { authorization: `Bearer ${a.token}` } }));
    expect(history.data.matches).toHaveLength(1);
    const entry = history.data.matches[0];
    expect(typeof entry.opponentName).toBe('string');
    expect(entry.opponentName.length).toBeGreaterThan(0);
  });
});
