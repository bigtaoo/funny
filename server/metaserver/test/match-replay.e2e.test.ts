// Match replay fetch end-to-end (S1-RP): /internal/match/report archives the replay → GET /match/{roomId}/replay.
//   Participants can retrieve it (two paths: inline or external replayRef), non-participants get 404, missing match gets 404.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, compressReplayDoc, decompressReplayDoc, type JwtConfig, type MongoHandle, type MatchReplayDoc } from '@nw/shared';
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

function reportPayload(
  roomId: string,
  a: string,
  b: string,
  frames: MatchReplayDoc['frames'],
  decks?: { top: string[]; bottom: string[] },
) {
  const replayDoc: MatchReplayDoc = {
    engineVersion: 0,
    mode: 'netplay',
    seed: '42',
    endFrame: 3,
    frames,
    meta: { recordedAt: 1, winner: 0 },
    ...(decks ? { decks } : {}),
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

/** Test helper: decompress the `replayGz` field from a GET /match/{roomId}/replay response. */
function decodeReplayGzResponse(data: { replayGz: string }): MatchReplayDoc {
  return decompressReplayDoc(Buffer.from(data.replayGz, 'base64'));
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
    const replay = decodeReplayGzResponse(body(res).data);
    expect(replay.endFrame).toBe(3);
    expect(replay.frames[0]!.cmds[0]!.commands).toBe('AAA=');
  });

  /**
   * Regression coverage (2026-07-15): the archived replay used to drop the match's deck loadout
   * (PVP_LOADOUT_DESIGN §6.2) entirely — playback would then rebuild the engine against the full
   * card pool, leaking ELO-locked cards into a replay of a match that never actually drew them.
   */
  it('participant retrieves the archived deck loadout alongside the replay', async () => {
    const decks = { top: ['infantry_2', 'archer_2'], bottom: ['infantry_1', 'archer_1', 'tower_1'] };
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('RR4', idA, idB, oneFrame, decks) });
    const res = await app.inject({ method: 'GET', url: '/match/RR4/replay', headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    expect(decodeReplayGzResponse(body(res).data).decks).toEqual(decks);
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
    // Build a frame log exceeding the inline threshold (256KB) *after gzip compression* → archived to
    // replayBlobs + replayRef. Random bytes (not a repeated char) so gzip can't shrink it away — the
    // inline/external decision is now made on compressed size (see REPLAY_INLINE_MAX_BYTES).
    const big = randomBytes(400 * 1024).toString('base64');
    const bigFrames = [{ frame: 3, cmds: [{ side: 0, commands: big }] }];
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('RR3', idA, idB, bigFrames) });
    // The matches document should have only replayRef, no inline replayGz; the blob collection holds the match.
    const doc = await m.collections.matches.findOne({ roomId: 'RR3' });
    expect(doc!.replayRef).toBe('RR3');
    expect(doc!.replayGz).toBeUndefined();
    const res = await app.inject({ method: 'GET', url: '/match/RR3/replay', headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    const replay = decodeReplayGzResponse(body(res).data);
    expect(replay.frames[0]!.cmds[0]!.commands.length).toBe(big.length);
  });

  /**
   * Cold-tier fallback (S1-RP, 2026-07-20): once Mongo's 7-day TTL purges the `matches` doc (simulated
   * here by deleting it directly), the participant-authorization check has no doc to check against
   * unless it falls back to the archived `<roomId>.meta.json` sidecar — verifies that fallback actually
   * reaches the disk archive instead of 404ing on the missing doc first.
   */
  it('participant retrieves the replay from disk archive after the Mongo doc is gone', async () => {
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('RR5', idA, idB, oneFrame) });
    // archiveMatch() is fire-and-forget from matchReport.ts — give it a tick to land on disk before deleting Mongo's copy.
    await new Promise((r) => setTimeout(r, 50));
    await m.collections.matches.deleteOne({ roomId: 'RR5' });
    const res = await app.inject({ method: 'GET', url: '/match/RR5/replay', headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    const replay = decodeReplayGzResponse(body(res).data);
    expect(replay.frames[0]!.cmds[0]!.commands).toBe('AAA=');
  });

  it('non-participant still gets 404 after the Mongo doc is gone (archived meta enforces the same authorization)', async () => {
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: reportPayload('RR6', idA, idB, oneFrame) });
    await new Promise((r) => setTimeout(r, 50));
    await m.collections.matches.deleteOne({ roomId: 'RR6' });
    const rc = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'rep-dddd-1' } }));
    const res = await app.inject({ method: 'GET', url: '/match/RR6/replay', headers: { authorization: `Bearer ${rc.data.token}` } });
    expect(res.statusCode).toBe(404);
  });
});
