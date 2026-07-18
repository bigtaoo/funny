// Route-level tests for internal/accountRoutes.ts (split out of internal.ts): profile/search/lookup/batch-profiles.
// Uses Fastify inject + in-memory fake cols (no Mongo) — same style as internal.test.ts / pve-anticheat.test.ts.
// elo/anticheat-reviews/social-friends(empty-stub)/suspicious-pve/ban/unban are already covered by
// internal.test.ts / anticheat-audit.e2e.test.ts / pve-anticheat.test.ts and are not repeated here.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { makeNewSave, type Collections, type SaveData } from '@nw/shared';
import { registerAccountRoutes } from '../src/internal/accountRoutes.js';
import type { InternalCtx } from '../src/internal/context.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeGateway, fakeCommercial, ThrowingSocialsvc } from './helpers/fakeClients.js';

interface AccountDoc {
  _id: string;
  publicId?: string;
  displayName?: string;
  password?: { loginId: string };
  flags?: { banned?: boolean };
}
interface SaveDocRow { _id: string; save: SaveData; rev: number }

const KEY = 'test-internal-key';

function build(seedAccounts: AccountDoc[] = [], seedSaves: SaveDocRow[] = []) {
  const accounts = new FakeCollection<AccountDoc>().seed(...seedAccounts);
  const saves = new FakeCollection<SaveDocRow>().seed(...seedSaves);
  const cols = { accounts, saves } as unknown as Collections;
  const ctx: InternalCtx = {
    cols,
    now: () => 1000,
    gateway: fakeGateway(),
    commercial: fakeCommercial(),
    socialsvc: new ThrowingSocialsvc(),
    authed: (key) => key === KEY,
  };
  const app = Fastify();
  registerAccountRoutes(app, ctx);
  return { app, accounts, saves };
}

function saveRow(id: string, extra: Partial<SaveData> = {}): SaveDocRow {
  const s = { ...makeNewSave(id, 1000), ...extra };
  return { _id: id, save: s, rev: s.rev };
}

const authHeaders = { 'x-internal-key': KEY };

describe('GET /internal/profile', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/profile?accountId=a' });
    expect(res.statusCode).toBe(401);
  });

  it('returns displayName + lazily-generated publicId + equipped title', async () => {
    const { app } = build(
      [{ _id: 'a', displayName: 'Alice' }],
      [saveRow('a', { equipped: { title: 't.ladder.1' } } as Partial<SaveData>)],
    );
    const res = await app.inject({ method: 'GET', url: '/internal/profile?accountId=a', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.displayName).toBe('Alice');
    expect(body.publicId).toMatch(/^\d{9}$/);
    expect(body.equippedTitle).toBe('t.ladder.1');
  });

  it('missing accountId → 400', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/profile', headers: authHeaders });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /internal/players/search', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/players/search?q=al' });
    expect(res.statusCode).toBe(401);
  });

  it('q shorter than 2 chars → empty result (not a 400 — avoids full-table scans)', async () => {
    const { app } = build([{ _id: 'a', displayName: 'Alice' }]);
    const res = await app.inject({ method: 'GET', url: '/internal/players/search?q=a', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).players).toEqual([]);
  });

  it('matches by displayName substring (case-insensitive)', async () => {
    const { app } = build([
      { _id: 'a', displayName: 'Restless Scholar' },
      { _id: 'b', displayName: 'Quiet Reader' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/internal/players/search?q=scholar', headers: authHeaders });
    const players = JSON.parse(res.payload).players;
    expect(players).toHaveLength(1);
    expect(players[0].accountId).toBe('a');
  });

  it('matches by exact publicId (9 digits)', async () => {
    const { app } = build([{ _id: 'a', publicId: '123456789' }]);
    const res = await app.inject({ method: 'GET', url: '/internal/players/search?q=123456789', headers: authHeaders });
    const players = JSON.parse(res.payload).players;
    expect(players).toHaveLength(1);
    expect(players[0].publicId).toBe('123456789');
  });

  it('matches by loginId prefix', async () => {
    const { app } = build([{ _id: 'a', password: { loginId: 'alice_login' } }]);
    const res = await app.inject({ method: 'GET', url: '/internal/players/search?q=alice', headers: authHeaders });
    const players = JSON.parse(res.payload).players;
    expect(players).toHaveLength(1);
    expect(players[0].loginId).toBe('alice_login');
  });

  it('limit is clamped to [1,50]', async () => {
    const accounts = Array.from({ length: 5 }, (_, i) => ({ _id: `p${i}`, displayName: `Player${i}` }));
    const { app } = build(accounts);
    const res = await app.inject({ method: 'GET', url: '/internal/players/search?q=Player&limit=999', headers: authHeaders });
    // limit clamps to 50 (well above our 5 seeded matches); just confirm no error and all 5 come back.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).players).toHaveLength(5);
  });
});

describe('GET /internal/player', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/player?publicId=123456789' });
    expect(res.statusCode).toBe(401);
  });

  it('missing publicId and accountId → 400', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/player', headers: authHeaders });
    expect(res.statusCode).toBe(400);
  });

  it('lookup by publicId → 404 when not found', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/player?publicId=999999999', headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });

  it('lookup by publicId → returns profile + pvp summary', async () => {
    const s = saveRow('a');
    s.save.pvp.elo = 1350;
    s.save.pvp.wins = 4;
    s.save.pvp.losses = 1;
    const { app } = build([{ _id: 'a', publicId: '123456789', displayName: 'Alice' }], [s]);
    const res = await app.inject({ method: 'GET', url: '/internal/player?publicId=123456789', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toMatchObject({ accountId: 'a', publicId: '123456789', displayName: 'Alice', elo: 1350, wins: 4, losses: 1 });
  });

  it('lookup by accountId → 404 when account row does not exist', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/player?accountId=ghost', headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });

  it('lookup by accountId → returns profile without pvp block when no save exists', async () => {
    const { app } = build([{ _id: 'a', publicId: '123456789' }]);
    const res = await app.inject({ method: 'GET', url: '/internal/player?accountId=a', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.accountId).toBe('a');
    expect(body.rank).toBeUndefined();
  });

  it('lookup by publicId → banned defaults to false when flags.banned is unset', async () => {
    const { app } = build([{ _id: 'a', publicId: '123456789' }]);
    const res = await app.inject({ method: 'GET', url: '/internal/player?publicId=123456789', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).banned).toBe(false);
  });

  it('lookup by publicId → surfaces banned:true (Player Lookup ban-status regression, 2026-07-18)', async () => {
    const { app } = build([{ _id: 'a', publicId: '123456789', flags: { banned: true } }]);
    const res = await app.inject({ method: 'GET', url: '/internal/player?publicId=123456789', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).banned).toBe(true);
  });

  it('lookup by accountId → surfaces banned:true', async () => {
    const { app } = build([{ _id: 'a', flags: { banned: true } }]);
    const res = await app.inject({ method: 'GET', url: '/internal/player?accountId=a', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).banned).toBe(true);
  });
});

describe('GET /internal/social/friends', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/social/friends?accountId=a' });
    expect(res.statusCode).toBe(401);
  });

  it('returns empty list (friend data lives in socialsvc post-P2; this is a fallback stub)', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/social/friends?accountId=a', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ friends: [] });
  });
});

describe('GET /internal/account/by-public-id/:publicId', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/account/by-public-id/123456789' });
    expect(res.statusCode).toBe(401);
  });

  it('not found → 404', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/account/by-public-id/000000000', headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });

  it('found → { accountId, profile }', async () => {
    const { app } = build([{ _id: 'a', publicId: '123456789', displayName: 'Alice' }]);
    const res = await app.inject({ method: 'GET', url: '/internal/account/by-public-id/123456789', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.accountId).toBe('a');
    expect(body.profile.publicId).toBe('123456789');
    expect(body.profile.displayName).toBe('Alice');
  });

  it('profile carries equippedTitle when the account has one equipped', async () => {
    const { app } = build(
      [{ _id: 'a', publicId: '123456789', displayName: 'Alice' }],
      [saveRow('a', { equipped: { title: 't.ladder.1' } } as Partial<SaveData>)],
    );
    const res = await app.inject({ method: 'GET', url: '/internal/account/by-public-id/123456789', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).profile.equippedTitle).toBe('t.ladder.1');
  });

  it('profile omits equippedTitle when no title is equipped', async () => {
    const { app } = build([{ _id: 'a', publicId: '123456789', displayName: 'Alice' }]);
    const res = await app.inject({ method: 'GET', url: '/internal/account/by-public-id/123456789', headers: authHeaders });
    expect(JSON.parse(res.payload).profile.equippedTitle).toBeUndefined();
  });
});

describe('POST /internal/account/batch-profiles', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/account/batch-profiles', payload: { accountIds: ['a'] } });
    expect(res.statusCode).toBe(401);
  });

  it('empty/missing accountIds → empty profiles map (no error)', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/account/batch-profiles', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ profiles: {} });
  });

  it('resolves each id with a publicId; skips accounts without one (profileOf returns null)', async () => {
    const s = saveRow('a');
    s.save.pvp.elo = 1400;
    const { app } = build(
      [{ _id: 'a', publicId: '123456789', displayName: 'Alice' }, { _id: 'b' /* no publicId */ }],
      [s],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/internal/account/batch-profiles',
      headers: authHeaders,
      payload: { accountIds: ['a', 'b', 'ghost'] },
    });
    expect(res.statusCode).toBe(200);
    const { profiles } = JSON.parse(res.payload);
    expect(Object.keys(profiles)).toEqual(['a']);
    expect(profiles.a).toMatchObject({ publicId: '123456789', displayName: 'Alice' });
  });

  it('includes equippedTitle for accounts with one equipped, omits it for the rest', async () => {
    const withTitle = saveRow('a', { equipped: { title: 't.ladder.1' } } as Partial<SaveData>);
    const noTitle = saveRow('b', { equipped: {} } as Partial<SaveData>);
    const { app } = build(
      [{ _id: 'a', publicId: '123456789', displayName: 'Alice' }, { _id: 'b', publicId: '987654321', displayName: 'Bob' }],
      [withTitle, noTitle],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/internal/account/batch-profiles',
      headers: authHeaders,
      payload: { accountIds: ['a', 'b'] },
    });
    expect(res.statusCode).toBe(200);
    const { profiles } = JSON.parse(res.payload);
    expect(profiles.a.equippedTitle).toBe('t.ladder.1');
    expect(profiles.b.equippedTitle).toBeUndefined();
  });
});
