// New-player ELO protection end-to-end (SEASON_DESIGN_IMPL_SPEC.md §15.5, 2026-10-07) against a real Mongo:
// POST /internal/match/report → settleElo → saves.pvp, plus the bot-fallback POST /pvp/bot-result.
//   - a fresh account's first 3 settled ranked games (wins count too) never cost ELO, and the response
//     handed to gameserver (→ match_over.elo) carries protectedGame/protectedTotal;
//   - the 4th game settles in full, with no losing streak carried over from the protected losses;
//   - two settlements racing for the same account's last protected slot: exactly one gets it;
//   - botsvc accounts (deviceId bot-NNNN) are never protected;
//   - bot-fallback losses are free inside the window and never use up a slot.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMongo,
  compressReplayDoc,
  computeEloDelta,
  NEWBIE_PROTECT_GAMES,
  type JwtConfig,
  type MongoHandle,
  type MatchReplayDoc,
} from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_newbie_protect_test';
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
if (!mongo) console.warn(`[newbie-protect.e2e] Mongo unreachable (${URI}) — skipping.`);

type Elo = { delta: number; after: number; rankAfter: string; protectedGame?: number; protectedTotal?: number };

function reportPayload(roomId: string, winner: string, loser: string) {
  const replayDoc: MatchReplayDoc = {
    engineVersion: 0, mode: 'netplay', seed: '42', endFrame: 3,
    frames: [{ frame: 3, cmds: [{ side: 0, commands: 'AAA=' }] }],
    meta: { recordedAt: 1, winner: 0 },
  };
  return {
    room_id: roomId, seed: '42', mode: 'ranked', reason: 'base', winner_side: 0, hash_ok: true,
    players: [{ side: 0, accountId: winner }, { side: 1, accountId: loser }],
    results: [{ side: 0, state_hash: 'H', winner_side: 0 }, { side: 1, state_hash: 'H', winner_side: 0 }],
    replay_gz: compressReplayDoc(replayDoc).toString('base64'),
  };
}

describe.skipIf(!mongo)('new-player ELO protection (e2e)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let room = 0;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const pvpOf = async (id: string) => (await m.collections.saves.findOne({ _id: id }))!.save.pvp;
  /** Settles one ranked match; returns { w, l } = the winner's and loser's EloResult. */
  const play = async (winner: string, loser: string): Promise<{ w: Elo; l: Elo }> => {
    const res = await app.inject({
      method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY },
      payload: reportPayload(`NP${++room}`, winner, loser),
    });
    expect(res.statusCode).toBe(200);
    const elo = body(res).elo as Record<number, Elo>;
    return { w: elo[0]!, l: elo[1]! };
  };
  /** Creates an account via device login and primes its save (settleElo only settles existing saves). */
  const account = async (deviceId: string): Promise<{ id: string; token: string }> => {
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } }));
    const token = r.data.token as string;
    const s = await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${token}` } });
    if (s.statusCode !== 200) throw new Error(`save priming failed: ${s.statusCode} ${s.payload.slice(0, 200)}`);
    return { id: r.data.accountId as string, token };
  };
  const setPvp = (id: string, fields: Record<string, number>) =>
    m.collections.saves.updateOne(
      { _id: id },
      { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`save.pvp.${k}`, v])) },
    );

  let vet: string;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
    vet = (await account('np-veteran-0001')).id;
    await setPvp(vet, { wins: 30, losses: 30 });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('first three settled games are protected (a win uses a slot too); the fourth settles in full', async () => {
    const fresh = (await account('np-fresh-0001')).id;

    // Game 1: the newcomer wins — normal gain, labelled 1/3; the veteran's loss is unaffected.
    const g1 = await play(fresh, vet);
    expect(g1.w).toMatchObject({ delta: 16, after: 1016, protectedGame: 1, protectedTotal: NEWBIE_PROTECT_GAMES });
    expect(g1.l).toEqual({ delta: -16, after: 984, rankAfter: 'bronze' });

    // Games 2-3: losses cost nothing; the veteran's gains are normal and unlabelled.
    for (const game of [2, 3]) {
      const g = await play(vet, fresh);
      expect(g.l).toEqual({ delta: 0, after: 1016, rankAfter: 'bronze', protectedGame: game, protectedTotal: 3 });
      expect(g.w.delta).toBeGreaterThan(0);
      expect(g.w.protectedGame).toBeUndefined();
    }
    let p = await pvpOf(fresh);
    expect(p).toMatchObject({ elo: 1016, wins: 1, losses: 2, streak: 0 });

    // Game 4: window used up — the loss is the plain K=32 swing (no -2 streak amplification).
    const vetElo = (await pvpOf(vet)).elo;
    const g4 = await play(vet, fresh);
    expect(g4.l.protectedGame).toBeUndefined();
    expect(g4.l.delta).toBe(computeEloDelta(vetElo, 1016).loser);
    p = await pvpOf(fresh);
    expect(p).toMatchObject({ elo: 1016 + g4.l.delta, losses: 3, streak: -1 });

    // The archived match carries the protected 0 for match history.
    const archived = await m.collections.matches.findOne({ roomId: 'NP2' });
    expect(archived!.players.find((x) => x.accountId === fresh)!.eloDelta).toBe(0);
  });

  it('two settlements racing for the last protected slot: exactly one gets it', async () => {
    const fresh = (await account('np-fresh-0002')).id;
    await setPvp(fresh, { losses: NEWBIE_PROTECT_GAMES - 1 });
    const [a, b] = await Promise.all([play(vet, fresh), play(vet, fresh)]);
    const protectedOnes = [a.l, b.l].filter((e) => e.protectedGame === NEWBIE_PROTECT_GAMES);
    const full = [a.l, b.l].filter((e) => e.protectedGame === undefined);
    expect(protectedOnes).toHaveLength(1);
    expect(protectedOnes[0]!.delta).toBe(0);
    expect(full).toHaveLength(1);
    expect(full[0]!.delta).toBeLessThan(0);
    const p = await pvpOf(fresh);
    expect(p.losses).toBe(NEWBIE_PROTECT_GAMES + 1);
    expect(p.elo).toBe(1000 + full[0]!.delta);
  });

  it('botsvc accounts (deviceId bot-NNNN) are never protected', async () => {
    const bot = (await account('bot-0001')).id;
    const g = await play(vet, bot);
    expect(g.l.protectedGame).toBeUndefined();
    expect(g.l.delta).toBeLessThan(0);
    const g2 = await play(bot, vet);
    expect(g2.w.protectedGame).toBeUndefined();
  });

  it('bot-fallback: a loss inside the window is free and does not use up a slot; a bot account still pays', async () => {
    const fresh = await account('np-fresh-0003');
    const r = await app.inject({
      method: 'POST', url: '/pvp/bot-result', headers: { authorization: `Bearer ${fresh.token}` }, payload: { won: false },
    });
    expect(r.statusCode).toBe(200);
    expect(body(r).data).toMatchObject({ delta: 0, elo: 1000 });
    expect(await pvpOf(fresh.id)).toMatchObject({ elo: 1000, wins: 0, losses: 0, streak: 0 });

    const bot = await account('bot-0002');
    const rb = await app.inject({
      method: 'POST', url: '/pvp/bot-result', headers: { authorization: `Bearer ${bot.token}` }, payload: { won: false },
    });
    expect(body(rb).data.delta).toBeLessThan(0);
  });
});
