// Unit tests for internal routes (S1-M3): /internal/elo fetch score + /internal/match/report ELO settlement/archival/idempotency.
// ELO settlement logic migrated from gameserver (M19, meta is authoritative). Uses fastify inject + in-memory fake cols (no Mongo).
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeNewSave, type Collections, type SaveData, type SaveDoc } from '@nw/shared';
import { registerInternalRoutes } from '../src/internal.js';
import type { GatewayClient, JudgeRes } from '../src/gatewayClient.js';
import type { CommercialClient } from '../src/commercialClient.js';

const KEY = 'test-internal-key';

/** Fake judge: configurable available flag + fixed verdict result (no real HTTP calls). */
function fakeGateway(opts: { available?: boolean; res?: JudgeRes; onJudge?: (req: unknown) => void } = {}): GatewayClient {
  return {
    available: opts.available ?? false,
    judge: async (req) => {
      opts.onJudge?.(req);
      return opts.res ?? { ok: false };
    },
    push: async () => {},
    presence: async () => ({}),
    invalidateFriends: async () => {},
  };
}

interface VictoryCall {
  accountId: string;
  amount: number;
  dayKey: string;
}

/** Fake commercial: only the available + victoryCredit subset used by internal.ts, records victory coin calls for assertions. */
function fakeCommercial(available = true): CommercialClient & { victoryCalls: VictoryCall[] } {
  const victoryCalls: VictoryCall[] = [];
  return {
    available,
    victoryCalls,
    victoryCredit: async (a: VictoryCall) => {
      victoryCalls.push(a);
      return { ok: true as const, coinsAfter: 0, credited: a.amount, capped: false };
    },
  } as unknown as CommercialClient & { victoryCalls: VictoryCall[] };
}

/** In-memory saves + matches: findOne / optimistic-lock findOneAndUpdate / unique-roomId insertOne. */
function fakeCols(seed: Record<string, SaveData>): { cols: Collections; matches: unknown[] } {
  const saves = new Map<string, SaveDoc>();
  for (const [id, s] of Object.entries(seed)) saves.set(id, { _id: id, save: s, rev: s.rev });
  const matches: { roomId: string; [k: string]: unknown }[] = [];
  const cols = {
    saves: {
      findOne: async (q: { _id: string }) => saves.get(q._id) ?? null,
      findOneAndUpdate: async (
        f: { _id: string; rev: number },
        u: { $set: { save: SaveData; rev: number } },
      ) => {
        const d = saves.get(f._id);
        if (!d || d.rev !== f.rev) return null;
        const next = { _id: d._id, save: u.$set.save, rev: u.$set.rev };
        saves.set(d._id, next);
        return next;
      },
    },
    matches: {
      findOne: async (q: { roomId: string }) => matches.find((m) => m.roomId === q.roomId) ?? null,
      insertOne: async (doc: { roomId: string }) => {
        if (matches.some((m) => m.roomId === doc.roomId)) throw { code: 11000 };
        matches.push(doc);
        return { insertedId: doc.roomId };
      },
      // Minimal chainable cursor for GET /internal/mismatches (C3): .find({hashMismatch,ts:{$gte}}).sort({ts:-1}).limit(200).project(...).toArray()
      find: (q: { hashMismatch?: boolean; ts?: { $gte: number } }) => {
        let items = matches.filter(
          (m) => (q.hashMismatch === undefined || m.hashMismatch === q.hashMismatch)
            && (q.ts?.$gte === undefined || (m.ts as number) >= q.ts.$gte),
        );
        const cursor = {
          sort: (spec: Record<string, 1 | -1>) => {
            const [[key, dir]] = Object.entries(spec);
            items = [...items].sort((a, b) => ((a[key] as number) - (b[key] as number)) * dir);
            return cursor;
          },
          limit: (n: number) => { items = items.slice(0, n); return cursor; },
          project: () => cursor,
          toArray: async () => items,
        };
        return cursor;
      },
    },
  } as unknown as Collections;
  return { cols, matches };
}

function build(
  cols: Collections,
  gateway: GatewayClient = fakeGateway(),
  commercial: CommercialClient = fakeCommercial(false),
  internalKeys?: Record<string, string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis?: any,
): FastifyInstance {
  const app = Fastify();
  registerInternalRoutes(app, {
    cols,
    internalKey: KEY,
    ...(internalKeys ? { internalKeys } : {}),
    now: () => 1000,
    gateway,
    commercial,
    ...(redis !== undefined ? { redis } : {}),
  });
  return app;
}

function emptyReplay() {
  return { engineVersion: 0, mode: 'netplay', seed: '1', endFrame: 0, frames: [], meta: { recordedAt: 0, winner: 0 } };
}

describe('internal routes', () => {
  it('GET /internal/elo no key → 401', async () => {
    const app = build(fakeCols({}).cols);
    const res = await app.inject({ method: 'GET', url: '/internal/elo?accountId=a' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // Internal auth model (S12-1): internal routes never validate player JWTs — only X-Internal-Key is accepted.
  // Player JWTs and internal keys are in different namespaces; placing one in the Authorization header will not match → 401.
  it('GET /internal/elo with player JWT but no X-Internal-Key → 401 (rejects player privilege escalation)', async () => {
    const app = build(fakeCols({}).cols);
    const res = await app.inject({
      method: 'GET',
      url: '/internal/elo?accountId=a',
      // Forge a seemingly valid player Authorization bearer — internal routes completely ignore it.
      headers: { authorization: 'Bearer player.jwt.token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // Per-caller strict mode (NW_INTERNAL_KEYS): each caller has its own dedicated key; the old single shared key is no longer accepted.
  it('strict mode: registered per-caller key is accepted, single shared key is rejected', async () => {
    const a = makeNewSave('a');
    a.pvp.elo = 777;
    const app = build(fakeCols({ a }).cols, fakeGateway(), fakeCommercial(false), {
      gateway: 'gw-key',
      gameserver: 'gs-key',
    });
    // gateway uses its own key → allowed.
    const okRes = await app.inject({
      method: 'GET',
      url: '/internal/elo?accountId=a',
      headers: { 'x-internal-key': 'gw-key', 'x-internal-caller': 'gateway' },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json()).toEqual({ elo: 777, seasonPeakElo: 1000 });
    // The old single shared key (KEY) is rejected in strict mode.
    const rejRes = await app.inject({
      method: 'GET',
      url: '/internal/elo?accountId=a',
      headers: { 'x-internal-key': KEY },
    });
    expect(rejRes.statusCode).toBe(401);
    await app.close();
  });

  it('GET /internal/elo fetches save ELO (default initial 1000)', async () => {
    const a = makeNewSave('a');
    a.pvp.elo = 1234;
    const app = build(fakeCols({ a }).cols);
    const r1 = await app.inject({ method: 'GET', url: '/internal/elo?accountId=a', headers: { 'x-internal-key': KEY } });
    expect(r1.json()).toEqual({ elo: 1234, seasonPeakElo: 1000 });
    const r2 = await app.inject({ method: 'GET', url: '/internal/elo?accountId=none', headers: { 'x-internal-key': KEY } });
    expect(r2.json()).toEqual({ elo: 1000, seasonPeakElo: 1000 });
    await app.close();
  });

  it('ranked base — both sides agree → settle ELO ±16, write saves, archive, return elo', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols, matches } = fakeCols({ a, b });
    const app = build(cols);
    const res = await app.inject({
      method: 'POST',
      url: '/internal/match/report',
      headers: { 'x-internal-key': KEY },
      payload: {
        room_id: 'R1',
        seed: '1',
        mode: 'ranked',
        reason: 'base',
        winner_side: 0,
        hash_ok: true,
        players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
        results: [{ side: 0, state_hash: 'H', winner_side: 0 }, { side: 1, state_hash: 'H', winner_side: 0 }],
        replay: emptyReplay(),
      },
    });
    const body = res.json() as { ok: boolean; elo?: Record<number, { delta: number; after: number }> };
    expect(body.ok).toBe(true);
    expect(body.elo![0]!.delta).toBe(16);
    expect(body.elo![0]!.after).toBe(1016);
    expect(body.elo![1]!.delta).toBe(-16);
    expect(matches).toHaveLength(1);
    const sa = await cols.saves.findOne({ _id: 'a' });
    expect(sa!.save.pvp.elo).toBe(1016);
    expect(sa!.save.pvp.wins).toBe(1);
    await app.close();
  });

  it('ECONOMY_BALANCE §2.3 streak acceleration: a hot winner gains more than a fresh loser loses (asymmetric, not zero-sum)', async () => {
    const a = makeNewSave('a');
    a.pvp.streak = 2; // already on a 2-win streak entering this match
    const b = makeNewSave('b'); // fresh (streak 0)
    const { cols } = fakeCols({ a, b });
    const app = build(cols);
    const res = await app.inject({
      method: 'POST',
      url: '/internal/match/report',
      headers: { 'x-internal-key': KEY },
      payload: {
        room_id: 'STK1',
        seed: '1',
        mode: 'ranked',
        reason: 'base',
        winner_side: 0,
        hash_ok: true,
        players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
        results: [{ side: 0, state_hash: 'H', winner_side: 0 }, { side: 1, state_hash: 'H', winner_side: 0 }],
        replay: emptyReplay(),
      },
    });
    const body = res.json() as { ok: boolean; elo?: Record<number, { delta: number; after: number }> };
    expect(body.elo![0]!.delta).toBe(21); // 32 * 1.3 streak multiplier * 0.5 expWin, rounded
    expect(body.elo![1]!.delta).toBe(-16); // plain K=32 for the fresh loser
    expect(body.elo![0]!.delta).not.toBe(-body.elo![1]!.delta);
    const sa = await cols.saves.findOne({ _id: 'a' });
    expect(sa!.save.pvp.streak).toBe(3);
    await app.close();
  });

  it('S9-6 ranked accumulates achievement stats: kill/cast credited for both sides + only winner stats.pvp.wins +1', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols, matches } = fakeCols({ a, b });
    const app = build(cols);
    await app.inject({
      method: 'POST',
      url: '/internal/match/report',
      headers: { 'x-internal-key': KEY },
      payload: {
        room_id: 'RS', seed: '1', mode: 'ranked', reason: 'base', winner_side: 0, hash_ok: true,
        players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
        results: [
          { side: 0, state_hash: 'H', winner_side: 0, stats: { 'kill.archer': 3, 'cast.meteor': 2 } },
          { side: 1, state_hash: 'H', winner_side: 0, stats: { 'kill.guard': 1, 'pvp.wins': 999 } }, // pvp.wins report is discarded
        ],
        replay: emptyReplay(),
      },
    });
    const sa = await cols.saves.findOne({ _id: 'a' });
    const sb = await cols.saves.findOne({ _id: 'b' });
    // Winner a: kill/cast stats credited + server auto-computes pvp.wins=1 (not from client report).
    expect(sa!.save.stats).toEqual({ 'kill.archer': 3, 'cast.meteor': 2, 'pvp.wins': 1 });
    // Loser b: kill/cast stats credited; self-reported pvp.wins:999 is discarded, and pvp.wins is not auto-incremented for the losing side.
    expect(sb!.save.stats).toEqual({ 'kill.guard': 1 });
    // S9-7: archive per-side reportedStats (values credited after L1 sanitization), for offline spot-check comparison (pvp.wins excluded).
    expect((matches[0] as { reportedStats?: unknown }).reportedStats).toEqual({
      '0': { 'kill.archer': 3, 'cast.meteor': 2 },
      '1': { 'kill.guard': 1 },
    });
    await app.close();
  });

  it('S9-6 L1 out-of-bounds: rejects that side\'s kill/cast, but ELO/pvp.wins still settled normally', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols } = fakeCols({ a, b });
    const app = build(cols);
    await app.inject({
      method: 'POST',
      url: '/internal/match/report',
      headers: { 'x-internal-key': KEY },
      payload: {
        room_id: 'RL', seed: '1', mode: 'ranked', reason: 'base', winner_side: 0, hash_ok: true,
        players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
        results: [
          { side: 0, state_hash: 'H', winner_side: 0, stats: { 'kill.archer': 999999 } }, // L1 out-of-bounds → entire stats rejected
          { side: 1, state_hash: 'H', winner_side: 0, stats: { 'kill.guard': 2 } },
        ],
        replay: emptyReplay(),
      },
    });
    const sa = await cols.saves.findOne({ _id: 'a' });
    const sb = await cols.saves.findOne({ _id: 'b' });
    // Winner a's kill.archer is rejected by L1, but pvp.wins is still auto-computed; ELO proceeds normally.
    expect(sa!.save.stats).toEqual({ 'pvp.wins': 1 });
    expect(sa!.save.pvp.elo).toBe(1016);
    // Loser b's kill.guard is credited normally.
    expect(sb!.save.stats).toEqual({ 'kill.guard': 2 });
    await app.close();
  });

  it('S9-6 friendly with stats → not accumulated (only ranked is credited)', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols, matches } = fakeCols({ a, b });
    const app = build(cols);
    await app.inject({
      method: 'POST',
      url: '/internal/match/report',
      headers: { 'x-internal-key': KEY },
      payload: {
        room_id: 'FS', seed: '1', mode: 'friendly', reason: 'base', winner_side: -1, hash_ok: true,
        players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
        results: [
          { side: 0, state_hash: 'H', winner_side: 0, stats: { 'kill.archer': 5 } },
          { side: 1, state_hash: 'H', winner_side: 0, stats: { 'kill.guard': 5 } },
        ],
        replay: emptyReplay(),
      },
    });
    const sa = await cols.saves.findOne({ _id: 'a' });
    expect(sa!.save.stats).toBeUndefined(); // friendly not settled → stats not credited
    // S9-7: friendly does not archive reportedStats (offline spot-checks only cover ranked; friendly is naturally excluded).
    expect((matches[0] as { reportedStats?: unknown }).reportedStats).toBeUndefined();
    await app.close();
  });

  it('ranked winner receives rank-victory coins (by post-settlement rank, winner only)', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols } = fakeCols({ a, b });
    const comm = fakeCommercial(true);
    const app = build(cols, fakeGateway(), comm);
    await app.inject({
      method: 'POST',
      url: '/internal/match/report',
      headers: { 'x-internal-key': KEY },
      payload: {
        room_id: 'RV',
        seed: '1',
        mode: 'ranked',
        reason: 'base',
        winner_side: 0,
        hash_ok: true,
        players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
        results: [{ side: 0, state_hash: 'H', winner_side: 0 }, { side: 1, state_hash: 'H', winner_side: 0 }],
        replay: emptyReplay(),
      },
    });
    // Only winner a receives coins; post-settlement ELO 1016 → bronze → 5 coins.
    expect(comm.victoryCalls).toHaveLength(1);
    expect(comm.victoryCalls[0]!.accountId).toBe('a');
    expect(comm.victoryCalls[0]!.amount).toBe(5);
    await app.close();
  });

  it('idempotent: duplicate report with same room_id does not settle twice', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols } = fakeCols({ a, b });
    const app = build(cols);
    const payload = {
      room_id: 'R1', seed: '1', mode: 'ranked', reason: 'base', winner_side: 0, hash_ok: true,
      players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
      results: [{ side: 0, state_hash: 'H', winner_side: 0 }, { side: 1, state_hash: 'H', winner_side: 0 }],
      replay: emptyReplay(),
    };
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload });
    const r2 = await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload });
    expect(r2.json()).toEqual({ ok: true }); // idempotent: no elo (already settled)
    const sa = await cols.saves.findOne({ _id: 'a' });
    expect(sa!.save.pvp.elo).toBe(1016); // still the value from a single settlement
    await app.close();
  });

  it('friendly report → ELO unchanged, archived winner -1', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols, matches } = fakeCols({ a, b });
    const app = build(cols);
    const res = await app.inject({
      method: 'POST',
      url: '/internal/match/report',
      headers: { 'x-internal-key': KEY },
      payload: {
        room_id: 'F1', seed: '1', mode: 'friendly', reason: 'base', winner_side: -1, hash_ok: true,
        players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
        results: [{ side: 0, state_hash: 'H', winner_side: 0 }, { side: 1, state_hash: 'H', winner_side: 0 }],
        replay: emptyReplay(),
      },
    });
    expect(res.json()).toEqual({ ok: true }); // friendly: no elo
    const sa = await cols.saves.findOne({ _id: 'a' });
    expect(sa!.save.pvp.elo).toBe(1000); // unchanged
    expect((matches[0] as { winner: number }).winner).toBe(-1);
    await app.close();
  });

  // ── Phase C peer judge ─────────────────────────────────────────────────────
  const mismatchPayload = {
    room_id: 'M1', seed: '1', mode: 'ranked', reason: 'mismatch', winner_side: 0, hash_ok: false,
    players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
    // Both sides report different hashes: a reports HONEST, b reports FAKE.
    results: [{ side: 0, state_hash: 'HONEST', winner_side: 0 }, { side: 1, state_hash: 'FAKE', winner_side: 1 }],
    replay: emptyReplay(),
  };

  it('ranked mismatch + judge matches a\'s hash → b judged as loser + archived cheat + ELO settled', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols, matches } = fakeCols({ a, b });
    const gateway = fakeGateway({
      available: true,
      res: { ok: true, stateHash: 'HONEST', winnerSide: 0, judgeAccountId: 'c' },
    });
    const app = build(cols, gateway);
    const res = await app.inject({
      method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: mismatchPayload,
    });
    const body = res.json() as { ok: boolean; elo?: Record<number, { delta: number }> };
    expect(body.ok).toBe(true);
    // Honest side a (side 0) wins +16, cheating side b (side 1) loses -16.
    expect(body.elo![0]!.delta).toBe(16);
    expect(body.elo![1]!.delta).toBe(-16);
    const sa = await cols.saves.findOne({ _id: 'a' });
    const sb = await cols.saves.findOne({ _id: 'b' });
    expect(sa!.save.pvp.elo).toBe(1016);
    expect(sb!.save.pvp.elo).toBe(984);
    const m = matches[0] as { winner: number; cheat?: { side: number; accountId: string; judgeAccountId?: string } };
    expect(m.cheat).toEqual({ side: 1, accountId: 'b', judgeAccountId: 'c' });
    expect(m.winner).toBe(0); // honest side
    await app.close();
  });

  it('PVP_LOADOUT §6.2 regression: judgeMismatch() forwards the match\'s decks to gateway.judge()', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols } = fakeCols({ a, b });
    const decks = { top: ['runner'], bottom: ['infantry_1'] };
    let seenReq: { decks?: { top: string[]; bottom: string[] } } | undefined;
    const gateway = fakeGateway({
      available: true,
      res: { ok: true, stateHash: 'HONEST', winnerSide: 0, judgeAccountId: 'c' },
      onJudge: (req) => { seenReq = req as typeof seenReq; },
    });
    const app = build(cols, gateway);
    await app.inject({
      method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY },
      payload: { ...mismatchPayload, replay: { ...emptyReplay(), decks } },
    });
    expect(seenReq?.decks).toEqual(decks);
    await app.close();
  });

  it('friendly-shaped replay without decks (PvE/siege or an unrestricted match) → judge called with no decks key', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols } = fakeCols({ a, b });
    let seenReq: { decks?: unknown } | undefined;
    const gateway = fakeGateway({
      available: true,
      res: { ok: true, stateHash: 'HONEST', winnerSide: 0, judgeAccountId: 'c' },
      onJudge: (req) => { seenReq = req as typeof seenReq; },
    });
    const app = build(cols, gateway);
    await app.inject({
      method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: mismatchPayload,
    });
    expect(seenReq?.decks).toBeUndefined();
    await app.close();
  });

  it('ranked mismatch + judge unavailable → voided (not settled, not flagged)', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols, matches } = fakeCols({ a, b });
    const app = build(cols, fakeGateway({ available: false }));
    const res = await app.inject({
      method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: mismatchPayload,
    });
    expect(res.json()).toEqual({ ok: true }); // no elo
    expect((await cols.saves.findOne({ _id: 'a' }))!.save.pvp.elo).toBe(1000);
    expect((matches[0] as { cheat?: unknown }).cheat).toBeUndefined();
    await app.close();
  });

  it('ranked mismatch + judge result matches neither side → voided', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols, matches } = fakeCols({ a, b });
    const gateway = fakeGateway({ available: true, res: { ok: true, stateHash: 'OTHER', winnerSide: 0 } });
    const app = build(cols, gateway);
    const res = await app.inject({
      method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: mismatchPayload,
    });
    expect(res.json()).toEqual({ ok: true });
    expect((await cols.saves.findOne({ _id: 'a' }))!.save.pvp.elo).toBe(1000);
    expect((matches[0] as { cheat?: unknown }).cheat).toBeUndefined();
    await app.close();
  });

  // ── C6-d hash mismatch + no judge → hashMismatch=true written to matches (CI guard) ──
  it('C6-d hash_ok=false + judge unavailable → matches.hashMismatch=true', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols, matches } = fakeCols({ a, b });
    const app = build(cols, fakeGateway({ available: false }));
    await app.inject({
      method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: mismatchPayload,
    });
    expect((matches[0] as { hashMismatch?: boolean }).hashMismatch).toBe(true);
    await app.close();
  });

  it('C6-d hash_ok=true → matches.hashMismatch not written', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols, matches } = fakeCols({ a, b });
    const app = build(cols, fakeGateway({ available: false }));
    const noMismatchPayload = {
      room_id: 'HASH_OK', seed: '1', mode: 'ranked', reason: 'base', winner_side: 0, hash_ok: true,
      players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
      results: [{ side: 0, state_hash: 'SAME', winner_side: 0 }, { side: 1, state_hash: 'SAME', winner_side: 0 }],
      replay: emptyReplay(),
    };
    await app.inject({
      method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: noMismatchPayload,
    });
    expect((matches[0] as { hashMismatch?: boolean }).hashMismatch).toBeUndefined();
    await app.close();
  });

  // ── login-reconnect-prompt: match report clears the cached resume ticket for both sides ──
  it('login-reconnect-prompt: match report clears activeMatch redis keys for both accountIds', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols } = fakeCols({ a, b });
    const redis = { del: vi.fn().mockResolvedValue(1) };
    const app = build(cols, fakeGateway(), fakeCommercial(false), undefined, redis);
    await app.inject({
      method: 'POST',
      url: '/internal/match/report',
      headers: { 'x-internal-key': KEY },
      payload: {
        room_id: 'RM1', seed: '1', mode: 'ranked', reason: 'base', winner_side: 0, hash_ok: true,
        players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
        results: [{ side: 0, state_hash: 'H', winner_side: 0 }, { side: 1, state_hash: 'H', winner_side: 0 }],
        replay: emptyReplay(),
      },
    });
    await Promise.resolve(); // flush the fire-and-forget clearActiveMatch() microtask
    expect(redis.del).toHaveBeenCalledWith('nw:activeMatch:a', 'nw:activeMatch:b');
    await app.close();
  });

  it('login-reconnect-prompt: idempotent repeat report does not clear redis again', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols } = fakeCols({ a, b });
    const redis = { del: vi.fn().mockResolvedValue(1) };
    const app = build(cols, fakeGateway(), fakeCommercial(false), undefined, redis);
    const payload = {
      room_id: 'RM2', seed: '1', mode: 'ranked', reason: 'base', winner_side: 0, hash_ok: true,
      players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
      results: [{ side: 0, state_hash: 'H', winner_side: 0 }, { side: 1, state_hash: 'H', winner_side: 0 }],
      replay: emptyReplay(),
    };
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload });
    await app.inject({ method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload });
    await Promise.resolve();
    expect(redis.del).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('login-reconnect-prompt: no redis configured → match report still succeeds (feature silently disabled)', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols } = fakeCols({ a, b });
    const app = build(cols); // no redis arg
    const res = await app.inject({
      method: 'POST',
      url: '/internal/match/report',
      headers: { 'x-internal-key': KEY },
      payload: {
        room_id: 'RM3', seed: '1', mode: 'friendly', reason: 'base', winner_side: -1, hash_ok: true,
        players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
        results: [{ side: 0, state_hash: 'H', winner_side: 0 }, { side: 1, state_hash: 'H', winner_side: 0 }],
        replay: emptyReplay(),
      },
    });
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});

describe('GET /internal/mismatches (C3)', () => {
  it('no key → 401', async () => {
    const app = build(fakeCols({}).cols);
    const res = await app.inject({ method: 'GET', url: '/internal/mismatches' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns only hashMismatch=true matches within the last 24h, newest first', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols, matches } = fakeCols({ a, b });
    const now = 1000;
    matches.push(
      { roomId: 'old', mode: 'ranked', players: [], reason: 'mismatch', hashMismatch: true, ts: now - 25 * 3600 * 1000 }, // outside 24h window
      { roomId: 'clean', mode: 'ranked', players: [], reason: 'base', ts: now }, // hashMismatch not set
      { roomId: 'm1', mode: 'ranked', players: [], reason: 'mismatch', hashMismatch: true, ts: now - 1000 },
      { roomId: 'm2', mode: 'ranked', players: [], reason: 'mismatch', hashMismatch: true, ts: now - 500 },
    );
    const app = build(cols);
    const res = await app.inject({ method: 'GET', url: '/internal/mismatches', headers: { 'x-internal-key': KEY } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.matches.map((m: { roomId: string }) => m.roomId)).toEqual(['m2', 'm1']);
    await app.close();
  });
});
