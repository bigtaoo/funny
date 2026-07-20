// PvP card win-rate pipeline e2e (BALANCE data pipeline P1): /internal/match/report accrues pvpCardStats from
// each side's deck → GET /internal/pvp-card-stats returns the aggregated per-card totals.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_pvpcardstats_test';
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
if (!mongo) console.warn(`[pvp-card-stats.e2e] Mongo unreachable (${URI}) — skipping.`);

function reportPayload(
  roomId: string,
  a: string,
  b: string,
  winnerSide: number,
  decks?: { top: string[]; bottom: string[] },
  extra: { mode?: string; hashOk?: boolean } = {},
) {
  return {
    room_id: roomId,
    seed: '42',
    mode: extra.mode ?? 'ranked',
    reason: 'base',
    winner_side: winnerSide,
    hash_ok: extra.hashOk ?? true,
    players: [{ side: 0, accountId: a }, { side: 1, accountId: b }],
    results: [
      { side: 0, state_hash: 'H', winner_side: winnerSide },
      { side: 1, state_hash: 'H', winner_side: winnerSide },
    ],
    replay: {
      engineVersion: 0,
      mode: 'netplay',
      seed: '42',
      endFrame: 3,
      frames: [{ frame: 3, cmds: [{ side: 0, commands: 'AAA=' }] }],
      meta: { recordedAt: 1, winner: winnerSide },
      ...(decks ? { decks } : {}),
    },
  };
}

describe.skipIf(!mongo)('pvp card stats e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let idA: string, idB: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
    const ra = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'pcs-aaaa-1' } }));
    const rb = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'pcs-bbbb-1' } }));
    idA = ra.data.accountId; idB = rb.data.accountId;
  });

  afterAll(async () => { if (app) await app.close(); });

  it('credits games to both decks and wins only to the winning side', async () => {
    const decks = { top: ['infantry_2', 'max_1'], bottom: ['archer_1', 'shieldbearer_1'] };
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('PC1', idA, idB, 0, decks) });

    const res = await app.inject({ method: 'GET', url: '/internal/pvp-card-stats', headers: { 'x-internal-key': KEY } });
    expect(res.statusCode).toBe(200);
    const cards = body(res).cards as { cardId: string; games: number; wins: number }[];
    const byId = Object.fromEntries(cards.map((c) => [c.cardId, c]));
    expect(byId.infantry_2).toEqual({ cardId: 'infantry_2', games: 1, wins: 1 });
    expect(byId.max_1).toEqual({ cardId: 'max_1', games: 1, wins: 1 });
    expect(byId.archer_1).toEqual({ cardId: 'archer_1', games: 1, wins: 0 });
    expect(byId.shieldbearer_1).toEqual({ cardId: 'shieldbearer_1', games: 1, wins: 0 });
  });

  it('excludes disputed matches (hash mismatch) from the counters', async () => {
    const decks = { top: ['infantry_2'], bottom: ['archer_1'] };
    await app.inject({
      method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY },
      payload: reportPayload('PC2', idA, idB, 0, decks, { hashOk: false }),
    });
    const res = await app.inject({ method: 'GET', url: '/internal/pvp-card-stats', headers: { 'x-internal-key': KEY } });
    const cards = body(res).cards as { cardId: string }[];
    expect(cards.find((c) => c.cardId === 'infantry_2')).toBeUndefined();
    expect(cards.find((c) => c.cardId === 'archer_1')).toBeUndefined();
  });

  it('skips matches with no restricted deck (full-pool friendly matches)', async () => {
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('PC3', idA, idB, 0) });
    const res = await app.inject({ method: 'GET', url: '/internal/pvp-card-stats', headers: { 'x-internal-key': KEY } });
    expect(body(res).cards).toEqual([]);
  });

  it('mode filter separates ranked from friendly', async () => {
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('PC4', idA, idB, 0, { top: ['infantry_2'], bottom: ['archer_1'] }, { mode: 'ranked' }) });
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('PC5', idA, idB, 1, { top: ['infantry_2'], bottom: ['archer_1'] }, { mode: 'friendly' }) });

    const ranked = body(await app.inject({ method: 'GET', url: '/internal/pvp-card-stats?mode=ranked', headers: { 'x-internal-key': KEY } })).cards as { cardId: string; games: number; wins: number }[];
    const rankedById = Object.fromEntries(ranked.map((c) => [c.cardId, c]));
    expect(rankedById.infantry_2).toEqual({ cardId: 'infantry_2', games: 1, wins: 1 });

    const friendly = body(await app.inject({ method: 'GET', url: '/internal/pvp-card-stats?mode=friendly', headers: { 'x-internal-key': KEY } })).cards as { cardId: string; games: number; wins: number }[];
    const friendlyById = Object.fromEntries(friendly.map((c) => [c.cardId, c]));
    expect(friendlyById.archer_1).toEqual({ cardId: 'archer_1', games: 1, wins: 1 });
  });

  it('unauthorized request without internal key is rejected', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal/pvp-card-stats' });
    expect(res.statusCode).toBe(401);
  });
});
