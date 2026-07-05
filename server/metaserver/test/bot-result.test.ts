// POST /pvp/bot-result (MATCHSVC_DESIGN §match_bot_fallback): AI-fallback matches are played entirely
// client-local (no gameserver session), so this is the only settlement hook for them. Verifies:
// always credits the 'pvp.match' daily task; ELO only moves below BOT_ELO_THRESHOLD at BOT_ELO_K;
// throttled by BOT_RESULT_MIN_GAP_MS so scripted spam can't out-pace the real 30s queue timeout.
import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { makeNewSave, BOT_ELO_K, BOT_ELO_THRESHOLD, type SaveData, type SaveDoc } from '@nw/shared';
import { MetaService, type ServiceDeps } from '../src/service.js';

function fakeCols(seed: Record<string, SaveData>) {
  const saves = new Map<string, SaveDoc>();
  for (const [id, s] of Object.entries(seed)) saves.set(id, { _id: id, save: s, rev: s.rev });
  return {
    saves: {
      findOne: async (q: { _id: string }) => saves.get(q._id) ?? null,
      updateOne: async () => ({}),
      findOneAndUpdate: async (f: { _id: string; rev: number }, u: { $set: { save: SaveData; rev: number } }) => {
        const d = saves.get(f._id);
        if (!d || d.rev !== f.rev) return null;
        const next = { _id: d._id, save: u.$set.save, rev: u.$set.rev };
        saves.set(d._id, next);
        return next;
      },
    },
    raw: saves,
  };
}

function makeService(nowRef: { t: number }, seed: Record<string, SaveData>) {
  const cols = fakeCols(seed);
  const deps = {
    cols,
    now: () => nowRef.t,
    authRateLimit: 0,
    gatewayPublicUrl: null,
    flags: null,
    region: null,
    lokiPushUrl: null,
    socialsvc: null,
  } as unknown as ServiceDeps;
  return { svc: new MetaService(deps), cols };
}

const reqOf = (accountId: string, won: boolean) =>
  ({ accountId, body: { won } }) as unknown as FastifyRequest;
const fakeReply = {} as unknown as FastifyReply;

describe('POST /pvp/bot-result', () => {
  it('below threshold: a win applies +BOT_ELO_K/2 and credits the daily task', async () => {
    const a = makeNewSave('a', 0);
    const nowRef = { t: 1_000_000 };
    const { svc, cols } = makeService(nowRef, { a });
    const res = (await svc.submitBotResult(reqOf('a', true), fakeReply)) as {
      data: { elo: number; rank: string; delta: number };
    };
    expect(res.data.delta).toBe(BOT_ELO_K / 2); // equal-elo vs itself → expWin 0.5
    expect(res.data.elo).toBe(1000 + BOT_ELO_K / 2);
    const saved = (await cols.saves.findOne({ _id: 'a' }))!.save;
    expect(saved.pvp.elo).toBe(1000 + BOT_ELO_K / 2);
    expect(saved.retention?.daily?.completedTasks?.['pvp.match']).toBeTruthy();
  });

  it('below threshold: a loss applies -BOT_ELO_K/2', async () => {
    const a = makeNewSave('a', 0);
    const nowRef = { t: 1_000_000 };
    const { svc } = makeService(nowRef, { a });
    const res = (await svc.submitBotResult(reqOf('a', false), fakeReply)) as { data: { delta: number } };
    expect(res.data.delta).toBe(-BOT_ELO_K / 2);
  });

  it('at/above BOT_ELO_THRESHOLD: ELO untouched, but the daily task still credits', async () => {
    const a = makeNewSave('a', 0);
    a.pvp.elo = BOT_ELO_THRESHOLD;
    const nowRef = { t: 1_000_000 };
    const { svc, cols } = makeService(nowRef, { a });
    const res = (await svc.submitBotResult(reqOf('a', true), fakeReply)) as { data: { delta: number; elo: number } };
    expect(res.data.delta).toBe(0);
    expect(res.data.elo).toBe(BOT_ELO_THRESHOLD);
    const saved = (await cols.saves.findOne({ _id: 'a' }))!.save;
    expect(saved.retention?.daily?.completedTasks?.['pvp.match']).toBeTruthy();
  });

  it('throttled: a second report within BOT_RESULT_MIN_GAP_MS does not move ELO again', async () => {
    const a = makeNewSave('a', 0);
    const nowRef = { t: 1_000_000 };
    const { svc } = makeService(nowRef, { a });
    const r1 = (await svc.submitBotResult(reqOf('a', true), fakeReply)) as { data: { delta: number } };
    expect(r1.data.delta).toBe(BOT_ELO_K / 2);
    nowRef.t += 5_000; // well under the 15s cooldown
    const r2 = (await svc.submitBotResult(reqOf('a', true), fakeReply)) as { data: { delta: number } };
    expect(r2.data.delta).toBe(0);
    nowRef.t += 20_000; // past the cooldown
    const r3 = (await svc.submitBotResult(reqOf('a', true), fakeReply)) as { data: { delta: number } };
    expect(r3.data.delta).toBe(BOT_ELO_K / 2);
  });
});
