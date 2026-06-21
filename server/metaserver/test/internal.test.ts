// 内部路由单测（S1-M3）：/internal/elo 取分 + /internal/match/report 结算 ELO/归档/幂等。
// ELO 结算逻辑从 gameserver 迁来（M19，meta 权威）。用 fastify inject + 内存 fake cols（无 Mongo）。
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeNewSave, type Collections, type SaveData, type SaveDoc } from '@nw/shared';
import { registerInternalRoutes } from '../src/internal.js';
import type { GatewayClient, JudgeRes } from '../src/gatewayClient.js';
import type { CommercialClient } from '../src/commercialClient.js';

const KEY = 'test-internal-key';

/** 假裁判：可配 available + 固定裁决结果（不发真 HTTP）。 */
function fakeGateway(opts: { available?: boolean; res?: JudgeRes } = {}): GatewayClient {
  return {
    available: opts.available ?? false,
    judge: async () => opts.res ?? { ok: false },
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

/** 假 commercial：仅 internal.ts 用到的 available + victoryCredit，记录胜利金币调用供断言。 */
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

/** 内存 saves + matches：findOne / 乐观锁 findOneAndUpdate / 唯一 roomId insertOne。 */
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
    },
  } as unknown as Collections;
  return { cols, matches };
}

function build(
  cols: Collections,
  gateway: GatewayClient = fakeGateway(),
  commercial: CommercialClient = fakeCommercial(false),
  internalKeys?: Record<string, string>,
): FastifyInstance {
  const app = Fastify();
  registerInternalRoutes(app, {
    cols,
    internalKey: KEY,
    ...(internalKeys ? { internalKeys } : {}),
    now: () => 1000,
    gateway,
    commercial,
  });
  return app;
}

function emptyReplay() {
  return { engineVersion: 0, mode: 'netplay', seed: '1', endFrame: 0, frames: [], meta: { recordedAt: 0, winner: 0 } };
}

describe('internal routes', () => {
  it('GET /internal/elo 无密钥 → 401', async () => {
    const app = build(fakeCols({}).cols);
    const res = await app.inject({ method: 'GET', url: '/internal/elo?accountId=a' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // 内部认证模型（S12-1）：内部路由从不校验玩家 JWT——只认 X-Internal-Key。
  // 玩家 JWT 与内部密钥不同命名空间，放 Authorization 头也命不中 → 401。
  it('GET /internal/elo 带玩家 JWT 但无 X-Internal-Key → 401（拒绝玩家越权）', async () => {
    const app = build(fakeCols({}).cols);
    const res = await app.inject({
      method: 'GET',
      url: '/internal/elo?accountId=a',
      // 伪造一个看似合法的玩家 Authorization bearer——内部路由根本不看它。
      headers: { authorization: 'Bearer player.jwt.token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // per-caller 严格模式（NW_INTERNAL_KEYS）：各调用方一把独立密钥；旧单一共享密钥不再被接受。
  it('严格模式：登记的 per-caller 密钥放行，单一共享密钥被拒', async () => {
    const a = makeNewSave('a');
    a.pvp.elo = 777;
    const app = build(fakeCols({ a }).cols, fakeGateway(), fakeCommercial(false), {
      gateway: 'gw-key',
      gameserver: 'gs-key',
    });
    // gateway 用自己的密钥 → 放行。
    const okRes = await app.inject({
      method: 'GET',
      url: '/internal/elo?accountId=a',
      headers: { 'x-internal-key': 'gw-key', 'x-internal-caller': 'gateway' },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json()).toEqual({ elo: 777 });
    // 旧的单一共享密钥（KEY）在严格模式下被拒。
    const rejRes = await app.inject({
      method: 'GET',
      url: '/internal/elo?accountId=a',
      headers: { 'x-internal-key': KEY },
    });
    expect(rejRes.statusCode).toBe(401);
    await app.close();
  });

  it('GET /internal/elo 取存档 ELO（缺省初始 1000）', async () => {
    const a = makeNewSave('a');
    a.pvp.elo = 1234;
    const app = build(fakeCols({ a }).cols);
    const r1 = await app.inject({ method: 'GET', url: '/internal/elo?accountId=a', headers: { 'x-internal-key': KEY } });
    expect(r1.json()).toEqual({ elo: 1234 });
    const r2 = await app.inject({ method: 'GET', url: '/internal/elo?accountId=none', headers: { 'x-internal-key': KEY } });
    expect(r2.json()).toEqual({ elo: 1000 });
    await app.close();
  });

  it('ranked base 双方一致 → 结算 ELO ±16，写 saves，归档，返回 elo', async () => {
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

  it('S9-6 ranked 累加成就计数：双方 kill/cast 入账 + 仅胜方 stats.pvp.wins +1', async () => {
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
          { side: 1, state_hash: 'H', winner_side: 0, stats: { 'kill.guard': 1, 'pvp.wins': 999 } }, // pvp.wins 上报被丢弃
        ],
        replay: emptyReplay(),
      },
    });
    const sa = await cols.saves.findOne({ _id: 'a' });
    const sb = await cols.saves.findOne({ _id: 'b' });
    // 胜方 a：kill/cast 入账 + 服务器自算 pvp.wins=1（非客户端上报）。
    expect(sa!.save.stats).toEqual({ 'kill.archer': 3, 'cast.meteor': 2, 'pvp.wins': 1 });
    // 负方 b：kill/cast 入账；自报的 pvp.wins:999 被丢弃，且非胜方不自增 pvp.wins。
    expect(sb!.save.stats).toEqual({ 'kill.guard': 1 });
    // S9-7：归档 per-side reportedStats（L1 清洗后已入账值），供离线抽查比对（pvp.wins 不含）。
    expect((matches[0] as { reportedStats?: unknown }).reportedStats).toEqual({
      '0': { 'kill.archer': 3, 'cast.meteor': 2 },
      '1': { 'kill.guard': 1 },
    });
    await app.close();
  });

  it('S9-6 L1 越界：拒收该方 kill/cast，但 ELO/pvp.wins 仍照常结算', async () => {
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
          { side: 0, state_hash: 'H', winner_side: 0, stats: { 'kill.archer': 999999 } }, // L1 越界 → 整份拒收
          { side: 1, state_hash: 'H', winner_side: 0, stats: { 'kill.guard': 2 } },
        ],
        replay: emptyReplay(),
      },
    });
    const sa = await cols.saves.findOne({ _id: 'a' });
    const sb = await cols.saves.findOne({ _id: 'b' });
    // 胜方 a 的 kill.archer 被 L1 拒收，但 pvp.wins 仍自算；ELO 照常。
    expect(sa!.save.stats).toEqual({ 'pvp.wins': 1 });
    expect(sa!.save.pvp.elo).toBe(1016);
    // 负方 b 正常 kill.guard 入账。
    expect(sb!.save.stats).toEqual({ 'kill.guard': 2 });
    await app.close();
  });

  it('S9-6 friendly 上报带 stats → 不累加（仅 ranked 喂）', async () => {
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
    expect(sa!.save.stats).toBeUndefined(); // friendly 不结算 → 不喂 stats
    // S9-7：friendly 不归档 reportedStats（离线抽查只查 ranked，天然不审 friendly）。
    expect((matches[0] as { reportedStats?: unknown }).reportedStats).toBeUndefined();
    await app.close();
  });

  it('ranked 胜者发分段胜利金币（按结算后段位，仅胜方）', async () => {
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
    // 仅胜者 a 发币；结算后 ELO 1016 → bronze → 5 金币。
    expect(comm.victoryCalls).toHaveLength(1);
    expect(comm.victoryCalls[0]!.accountId).toBe('a');
    expect(comm.victoryCalls[0]!.amount).toBe(5);
    await app.close();
  });

  it('幂等：同 room_id 重复上报不二次结算', async () => {
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
    expect(r2.json()).toEqual({ ok: true }); // 幂等：无 elo（已结算过）
    const sa = await cols.saves.findOne({ _id: 'a' });
    expect(sa!.save.pvp.elo).toBe(1016); // 仍是一次结算的值
    await app.close();
  });

  it('friendly 上报 → 不动 ELO，归档 winner -1', async () => {
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
    expect(res.json()).toEqual({ ok: true }); // friendly 无 elo
    const sa = await cols.saves.findOne({ _id: 'a' });
    expect(sa!.save.pvp.elo).toBe(1000); // 未变
    expect((matches[0] as { winner: number }).winner).toBe(-1);
    await app.close();
  });

  // ── Phase C 对等裁判 ─────────────────────────────────────────────────────
  const mismatchPayload = {
    room_id: 'M1', seed: '1', mode: 'ranked', reason: 'mismatch', winner_side: 0, hash_ok: false,
    players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
    // 两端 hash 不一致：a 报 HONEST，b 报 FAKE。
    results: [{ side: 0, state_hash: 'HONEST', winner_side: 0 }, { side: 1, state_hash: 'FAKE', winner_side: 1 }],
    replay: emptyReplay(),
  };

  it('ranked 不一致 + 裁判命中 a 的 hash → b 判负 + 归档 cheat + 结算 ELO', async () => {
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
    // 诚实方 a（side 0）赢 +16，作弊方 b（side 1）输 -16。
    expect(body.elo![0]!.delta).toBe(16);
    expect(body.elo![1]!.delta).toBe(-16);
    const sa = await cols.saves.findOne({ _id: 'a' });
    const sb = await cols.saves.findOne({ _id: 'b' });
    expect(sa!.save.pvp.elo).toBe(1016);
    expect(sb!.save.pvp.elo).toBe(984);
    const m = matches[0] as { winner: number; cheat?: { side: number; accountId: string; judgeAccountId?: string } };
    expect(m.cheat).toEqual({ side: 1, accountId: 'b', judgeAccountId: 'c' });
    expect(m.winner).toBe(0); // 诚实方
    await app.close();
  });

  it('ranked 不一致 + 裁判不可用 → 作废（不结算、不标记）', async () => {
    const a = makeNewSave('a');
    const b = makeNewSave('b');
    const { cols, matches } = fakeCols({ a, b });
    const app = build(cols, fakeGateway({ available: false }));
    const res = await app.inject({
      method: 'POST', url: '/internal/match/report', headers: { 'x-internal-key': KEY }, payload: mismatchPayload,
    });
    expect(res.json()).toEqual({ ok: true }); // 无 elo
    expect((await cols.saves.findOne({ _id: 'a' }))!.save.pvp.elo).toBe(1000);
    expect((matches[0] as { cheat?: unknown }).cheat).toBeUndefined();
    await app.close();
  });

  it('ranked 不一致 + 裁判结果对不上任何一方 → 作废', async () => {
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
});
