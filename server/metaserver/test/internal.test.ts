// 内部路由单测（S1-M3）：/internal/elo 取分 + /internal/match/report 结算 ELO/归档/幂等。
// ELO 结算逻辑从 gameserver 迁来（M19，meta 权威）。用 fastify inject + 内存 fake cols（无 Mongo）。
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeNewSave, type Collections, type SaveData, type SaveDoc } from '@nw/shared';
import { registerInternalRoutes } from '../src/internal.js';

const KEY = 'test-internal-key';

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

function build(cols: Collections): FastifyInstance {
  const app = Fastify();
  registerInternalRoutes(app, { cols, internalKey: KEY, now: () => 1000 });
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
});
