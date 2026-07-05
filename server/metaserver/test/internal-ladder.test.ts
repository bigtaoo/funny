// Route-level tests for internal/ladderRoutes.ts (split out of internal.ts):
//   admin/ladder/season/roll, internal/ladder/season/current, admin/grant-title, internal/leaderboard, internal/title/grant.
// rollSeason's settlement internals (mail/title/snapshot idempotency) are already covered in depth by
// season-close.test.ts at the function level — these tests only verify the HTTP route wiring (auth/params/status codes).
// Uses Fastify inject + in-memory fake cols (no Mongo) — same style as internal.test.ts.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { makeNewSave, eloToRank, type Collections, type SaveData, type LadderSeasonDoc } from '@nw/shared';
import { registerLadderRoutes } from '../src/internal/ladderRoutes.js';
import type { InternalCtx } from '../src/internal/context.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeGateway, fakeCommercial, FakeSocialsvc } from './helpers/fakeClients.js';

interface SaveDocRow { _id: string; save: SaveData; rev: number }
interface AccountDoc { _id: string; displayName?: string; publicId?: string }

const KEY = 'test-internal-key';
const authHeaders = { 'x-internal-key': KEY };

function saveRow(id: string, elo: number, seasonNo = 1): SaveDocRow {
  const s = makeNewSave(id, 1000);
  s.pvp.elo = elo;
  s.pvp.rank = eloToRank(elo);
  s.pvp.seasonNo = seasonNo;
  s.pvp.seasonPeakElo = elo; // season settlement rewards are computed off the peak, not the live elo
  s.pvp.seasonPeakRank = eloToRank(elo);
  return { _id: id, save: s, rev: s.rev };
}

function build(opts: { saves?: SaveDocRow[]; accounts?: AccountDoc[]; season?: LadderSeasonDoc } = {}) {
  const saves = new FakeCollection<SaveDocRow>().seed(...(opts.saves ?? []));
  const accounts = new FakeCollection<AccountDoc>().seed(...(opts.accounts ?? []));
  const ladderSeasons = new FakeCollection<LadderSeasonDoc & { _id: string }>();
  if (opts.season) ladderSeasons.seed(opts.season);
  const ladderSeasonSnapshots = new FakeCollection<{ _id: string }>();
  const cols = { saves, accounts, ladderSeasons, ladderSeasonSnapshots } as unknown as Collections;
  const socialsvc = new FakeSocialsvc();
  const commercial = fakeCommercial();
  const ctx: InternalCtx = {
    cols,
    now: () => 5000,
    gateway: fakeGateway(),
    commercial,
    socialsvc,
    authed: (key) => key === KEY,
  };
  const app = Fastify();
  registerLadderRoutes(app, ctx);
  return { app, saves, accounts, ladderSeasons, ladderSeasonSnapshots, socialsvc, commercial };
}

describe('GET /internal/ladder/season/current', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/ladder/season/current' });
    expect(res.statusCode).toBe(401);
  });

  it('lazily creates season #1 on first call', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/ladder/season/current', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.season).toMatchObject({ seasonNo: 1, state: 'active' });
  });

  it('returns the existing season doc when already created', async () => {
    const { app } = build({ season: { _id: 'current', seasonNo: 3, startAt: 0, endAt: 9999, state: 'active' } });
    const res = await app.inject({ method: 'GET', url: '/internal/ladder/season/current', headers: authHeaders });
    expect(JSON.parse(res.payload).season.seasonNo).toBe(3);
  });
});

describe('POST /admin/ladder/season/roll', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/ladder/season/roll' });
    expect(res.statusCode).toBe(401);
  });

  it('settles previous season participants + advances to the next season', async () => {
    const { app, socialsvc } = build({
      saves: [saveRow('alice', 1900, 1)],
      season: { _id: 'current', seasonNo: 1, startAt: 0, endAt: 1000, state: 'active' },
    });
    const res = await app.inject({ method: 'POST', url: '/admin/ladder/season/roll', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.season.seasonNo).toBe(2);
    expect(socialsvc.mail.size).toBe(1); // alice (master tier) settled with reward mail
  });

  it('CAS guard: state=settling (mid-flight, e.g. a concurrent roll in progress) → returns current season, does not re-advance', async () => {
    const { app } = build({
      season: { _id: 'current', seasonNo: 5, startAt: 0, endAt: 1000, state: 'settling' },
    });
    const res = await app.inject({ method: 'POST', url: '/admin/ladder/season/roll', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).season).toMatchObject({ seasonNo: 5, state: 'settling' });
  });
});

describe('POST /admin/grant-title', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/grant-title', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('missing params → 400', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/admin/grant-title', headers: authHeaders, payload: { accountId: 'a' } });
    expect(res.statusCode).toBe(400);
  });

  it('grants a title to an existing save (idempotent on repeat)', async () => {
    const { app, saves } = build({ saves: [saveRow('a', 1200)] });
    const res = await app.inject({
      method: 'POST', url: '/admin/grant-title', headers: authHeaders,
      payload: { accountId: 'a', titleId: 'ops.special' },
    });
    expect(res.statusCode).toBe(200);
    expect((saves.docs.get('a')!.save as { titles?: string[] }).titles).toContain('ops.special');

    const res2 = await app.inject({
      method: 'POST', url: '/admin/grant-title', headers: authHeaders,
      payload: { accountId: 'a', titleId: 'ops.special' },
    });
    expect(res2.statusCode).toBe(200);
    expect((saves.docs.get('a')!.save as { titles?: string[] }).titles).toEqual(['ops.special']);
  });
});

describe('POST /internal/title/grant', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/title/grant', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('missing params → 400', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/title/grant', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('grants a title (called from SLG/worldsvc season settlement)', async () => {
    const { app, saves } = build({ saves: [saveRow('a', 1200)] });
    const res = await app.inject({
      method: 'POST', url: '/internal/title/grant', headers: authHeaders,
      payload: { accountId: 'a', titleId: 'slg.s1.champion' },
    });
    expect(res.statusCode).toBe(200);
    expect((saves.docs.get('a')!.save as { titles?: string[] }).titles).toContain('slg.s1.champion');
  });

  it('no save for accountId → still ok:true (grantTitleToPlayer skips silently)', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/internal/title/grant', headers: authHeaders,
      payload: { accountId: 'ghost', titleId: 'slg.s1.champion' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
  });
});

describe('GET /internal/leaderboard', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/leaderboard' });
    expect(res.statusCode).toBe(401);
  });

  it('returns Top100 sorted by elo desc, scoped to the current season', async () => {
    const { app } = build({
      saves: [saveRow('a', 1200), saveRow('b', 1800), saveRow('c', 1500), saveRow('old', 2000, 0 /* stale season */)],
      accounts: [{ _id: 'a', displayName: 'Alice' }, { _id: 'b', displayName: 'Bob' }, { _id: 'c', displayName: 'Carl' }],
      season: { _id: 'current', seasonNo: 1, startAt: 0, endAt: 9999, state: 'active' },
    });
    const res = await app.inject({ method: 'GET', url: '/internal/leaderboard', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.top.map((e: { accountId: string }) => e.accountId)).toEqual(['b', 'c', 'a']);
    expect(body.top[0]).toMatchObject({ rank: 1, accountId: 'b', displayName: 'Bob', elo: 1800 });
  });
});
