// ELO-loss protection end-to-end (SEASON_DESIGN_IMPL_SPEC.md §15.5, 2026-10-07) against a real Mongo:
// POST /internal/match/report → settleElo → saves.pvp, plus the bot-fallback POST /pvp/bot-result.
//   - a fresh account's day: games 1-3 use new-player slots, 4-6 daily slots, 7 settles in full; the
//     response handed to gameserver (→ match_over.elo) carries protectedGame/Total/Kind;
//   - next day (stored day key older than today = lazy reset): 3 daily slots again;
//   - two settlements racing for the same account's last daily slot: exactly one gets it;
//   - botsvc accounts (deviceId bot-NNNN) are never protected;
//   - bot-fallback losses are free while a slot is left and never use one up.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMongo,
  compressReplayDoc,
  computeEloDelta,
  makeDayKey,
  DAILY_PROTECT_GAMES,
  PROTECT_KIND_NEWBIE,
  PROTECT_KIND_DAILY,
  type JwtConfig,
  type MongoHandle,
  type MatchReplayDoc,
} from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_elo_protect_test';
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
if (!mongo) console.warn(`[elo-protect.e2e] Mongo unreachable (${URI}) — skipping.`);

type Elo = { delta: number; after: number; rankAfter: string; protectedGame?: number; protectedTotal?: number; protectedKind?: number };

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

const today = () => makeDayKey(Date.now());
const yesterday = () => makeDayKey(Date.now() - 86_400_000);

describe.skipIf(!mongo)('ELO-loss protection (e2e)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let room = 0;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const pvpOf = async (id: string) => (await m.collections.saves.findOne({ _id: id }))!.save.pvp;
  /** Settles one ranked match; returns { w, l } = the winner's and loser's EloResult. */
  const play = async (winner: string, loser: string): Promise<{ w: Elo; l: Elo }> => {
    const res = await app.inject({
      method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY },
      payload: reportPayload(`EP${++room}`, winner, loser),
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
  const setPvp = (id: string, fields: Record<string, unknown>) =>
    m.collections.saves.updateOne(
      { _id: id },
      { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`save.pvp.${k}`, v])) },
    );
  /** A veteran with today's daily slots spent: its games always settle in full. */
  const spendToday = (id: string) => setPvp(id, { dailyProtect: { dayKey: today(), used: DAILY_PROTECT_GAMES } });

  let vet: string;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
    vet = (await account('ep-veteran-0001')).id;
    await setPvp(vet, { wins: 30, losses: 30 });
    await spendToday(vet);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('a new account: 1-3 new-player, 4-6 daily, 7 in full; next day 3 daily slots again', async () => {
    const fresh = (await account('ep-fresh-0001')).id;

    // Game 1: the newcomer wins — normal gain, labelled new-player 1/3; the veteran's loss is unaffected.
    const g1 = await play(fresh, vet);
    expect(g1.w).toMatchObject({ delta: 16, after: 1016, protectedGame: 1, protectedTotal: 3, protectedKind: PROTECT_KIND_NEWBIE });
    expect(g1.l).toEqual({ delta: -16, after: 984, rankAfter: 'bronze' });

    // Games 2-6: losses cost nothing (2-3 new-player, 4-6 daily); the veteran's gains are normal and unlabelled.
    const expected = [[2, PROTECT_KIND_NEWBIE], [3, PROTECT_KIND_NEWBIE], [1, PROTECT_KIND_DAILY], [2, PROTECT_KIND_DAILY], [3, PROTECT_KIND_DAILY]];
    for (const [game, kind] of expected) {
      const g = await play(vet, fresh);
      expect(g.l).toEqual({ delta: 0, after: 1016, rankAfter: 'bronze', protectedGame: game, protectedTotal: 3, protectedKind: kind });
      expect(g.w.delta).toBeGreaterThan(0);
      expect(g.w.protectedGame).toBeUndefined();
    }
    let p = await pvpOf(fresh);
    expect(p).toMatchObject({ elo: 1016, wins: 1, losses: 5, streak: 0, dailyProtect: { dayKey: today(), used: 3 } });

    // Game 7: both pools spent — the loss is the plain K=32 swing (no streak amplification).
    const vetElo = (await pvpOf(vet)).elo;
    const g7 = await play(vet, fresh);
    expect(g7.l.protectedGame).toBeUndefined();
    expect(g7.l.delta).toBe(computeEloDelta(vetElo, 1016).loser);
    p = await pvpOf(fresh);
    expect(p).toMatchObject({ elo: 1016 + g7.l.delta, losses: 6, streak: -1 });

    // The archived match carries the protected 0 for match history.
    const archived = await m.collections.matches.findOne({ roomId: 'EP2' });
    expect(archived!.players.find((x) => x.accountId === fresh)!.eloDelta).toBe(0);

    // "Next day": the stored counter is from an older day key → lazy reset to 3 fresh daily slots.
    await setPvp(fresh, { dailyProtect: { dayKey: yesterday(), used: 3 } });
    const eloNow = (await pvpOf(fresh)).elo;
    for (const game of [1, 2, 3]) {
      const g = await play(vet, fresh);
      expect(g.l).toMatchObject({ delta: 0, after: eloNow, protectedGame: game, protectedKind: PROTECT_KIND_DAILY });
    }
    const g4 = await play(vet, fresh);
    expect(g4.l.protectedGame).toBeUndefined();
    expect(g4.l.delta).toBeLessThan(0);
    expect((await pvpOf(fresh)).dailyProtect).toEqual({ dayKey: today(), used: 3 });
  });

  it('two settlements racing for the last daily slot: exactly one gets it', async () => {
    const fresh = (await account('ep-fresh-0002')).id;
    await setPvp(fresh, { losses: 10, dailyProtect: { dayKey: today(), used: DAILY_PROTECT_GAMES - 1 } });
    const [a, b] = await Promise.all([play(vet, fresh), play(vet, fresh)]);
    const protectedOnes = [a.l, b.l].filter((e) => e.protectedGame === DAILY_PROTECT_GAMES);
    const full = [a.l, b.l].filter((e) => e.protectedGame === undefined);
    expect(protectedOnes).toHaveLength(1);
    expect(protectedOnes[0]!.delta).toBe(0);
    expect(full).toHaveLength(1);
    expect(full[0]!.delta).toBeLessThan(0);
    const p = await pvpOf(fresh);
    expect(p.losses).toBe(12);
    expect(p.elo).toBe(1000 + full[0]!.delta);
    expect(p.dailyProtect).toEqual({ dayKey: today(), used: DAILY_PROTECT_GAMES });
  });

  it('botsvc accounts (deviceId bot-NNNN) are never protected', async () => {
    const bot = (await account('bot-0001')).id;
    const g = await play(vet, bot);
    expect(g.l.protectedGame).toBeUndefined();
    expect(g.l.delta).toBeLessThan(0);
    const g2 = await play(bot, vet);
    expect(g2.w.protectedGame).toBeUndefined();
    expect((await pvpOf(bot)).dailyProtect).toBeUndefined();
  });

  it('bot-fallback: a loss is free while a slot is left and uses none up; spent slots or a bot account pay', async () => {
    const fresh = await account('ep-fresh-0003');
    const loseToAi = async (token: string) => {
      const r = await app.inject({
        method: 'POST', url: '/pvp/bot-result', headers: { authorization: `Bearer ${token}` }, payload: { won: false },
      });
      expect(r.statusCode).toBe(200);
      return body(r).data as { delta: number; elo: number };
    };
    expect(await loseToAi(fresh.token)).toMatchObject({ delta: 0, elo: 1000 });
    const p = await pvpOf(fresh.id);
    expect(p).toMatchObject({ elo: 1000, wins: 0, losses: 0, streak: 0 });
    expect(p.dailyProtect).toBeUndefined();

    // A veteran with daily slots left today: still free (the throttle is per-account, so this is its first).
    const vet2 = await account('ep-veteran-0002');
    await setPvp(vet2.id, { wins: 5, losses: 5, dailyProtect: { dayKey: today(), used: 2 } });
    expect((await loseToAi(vet2.token)).delta).toBe(0);
    expect((await pvpOf(vet2.id)).dailyProtect).toEqual({ dayKey: today(), used: 2 });

    // The always-spent veteran pays.
    const vetTok = await account('ep-veteran-0001');
    expect((await loseToAi(vetTok.token)).delta).toBeLessThan(0);

    const bot = await account('bot-0002');
    expect((await loseToAi(bot.token)).delta).toBeLessThan(0);
  });
});
