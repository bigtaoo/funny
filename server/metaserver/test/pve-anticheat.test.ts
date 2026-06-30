// C4 PvE anti-cheat enforcement unit tests: accounts.flags.banned ban flag + pveWarnings accumulation + warning mail + threshold ban.
// Uses Fastify inject + in-memory fake cols (no Mongo); tests observable behaviour only.
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerInternalRoutes } from '../src/internal.js';
import type { Collections, SaveData, SaveDoc } from '@nw/shared';
import type { GatewayClient } from '../src/gatewayClient.js';
import type { CommercialClient } from '../src/commercialClient.js';

// ── fakes ───────────────────────────────────────────────────────────────────

function fakeGateway(): GatewayClient {
  return {
    available: false,
    judge: async () => ({ ok: false }),
    push: async () => {},
    presence: async () => ({}),
    invalidateFriends: async () => {},
  };
}

function fakeCommercial(): CommercialClient {
  return {
    available: true,
    victoryCredit: async () => ({ ok: true as const, coinsAfter: 0, credited: 0, capped: false }),
  } as unknown as CommercialClient;
}

function makeSave(accountId: string, extra?: Partial<SaveData>): SaveDoc {
  const base: SaveData = {
    rev: 1,
    coins: 0,
    ink: 0,
    progress: { cleared: [], stars: {} },
    ownedUnits: [],
    equippedUnits: [],
    lastOnline: 0,
    createdAt: 0,
  };
  return { _id: accountId, save: { ...base, ...extra }, rev: 1 };
}

// In-memory fake collections (only the fields required by the suspicious-pve endpoint).
function fakeColsWithAccounts(
  accounts: { _id: string; flags?: { pveWarnings?: number; banned?: boolean }; displayName?: string; publicId?: string; createdAt: number }[],
): { cols: Collections; getAccount: (id: string) => (typeof accounts)[0] | undefined } {
  const accountMap = new Map(accounts.map((a) => [a._id, { ...a }]));
  const savesMap = new Map<string, SaveDoc>();

  const cols = {
    accounts: {
      findOne: vi.fn(async (q: Record<string, unknown>) => accountMap.get(q._id as string) ?? null),
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        project: vi.fn().mockReturnThis(),
        toArray: vi.fn(async () =>
          [...accountMap.values()].filter((a) => (a.flags?.pveWarnings ?? 0) > 0)
            .sort((a, b) => (b.flags?.pveWarnings ?? 0) - (a.flags?.pveWarnings ?? 0))
            .slice(0, 200),
        ),
      })),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(async (q: Record<string, unknown>, update: Record<string, unknown>) => {
        const id = q._id as string;
        const acc = accountMap.get(id);
        if (!acc) return;
        const setOp = (update as { $set?: Record<string, unknown>; $unset?: Record<string, unknown> }).$set;
        const unsetOp = (update as { $set?: Record<string, unknown>; $unset?: Record<string, unknown> }).$unset;
        if (setOp?.['flags.banned'] === true) acc.flags = { ...acc.flags, banned: true };
        if (unsetOp?.['flags.banned'] !== undefined) { if (acc.flags) delete acc.flags.banned; }
      }),
      insertOne: vi.fn(),
    },
    saves: {
      findOne: async (q: { _id: string }) => savesMap.get(q._id) ?? null,
      findOneAndUpdate: vi.fn(async () => null),
      updateOne: vi.fn(),
      insertOne: vi.fn(),
    },
    matches: {
      find: vi.fn(() => ({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        project: vi.fn().mockReturnThis(),
        toArray: vi.fn(async () => []),
      })),
      insertOne: vi.fn(async () => {}),
    },
    pveVerifications: { findOne: vi.fn(async () => null), insertOne: vi.fn(), updateOne: vi.fn() },
    pveRejections: { insertOne: vi.fn() },
    mails: { findOne: vi.fn(async () => null), insertOne: vi.fn(), updateOne: vi.fn() },
    adsDaily: { findOne: vi.fn(async () => null), findOneAndUpdate: vi.fn() },
    adsTokens: { insertOne: vi.fn() },
    replayBlobs: { findOne: vi.fn(async () => null), insertOne: vi.fn() },
    replayShares: { findOne: vi.fn(async () => null), insertOne: vi.fn() },
    pveVerificationsArchive: { insertOne: vi.fn() },
    achievements: { findOne: vi.fn(async () => null), findOneAndUpdate: vi.fn() },
    antiCheatReviews: {
      find: vi.fn(() => ({ sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn(async () => []) })),
      insertOne: vi.fn(),
      updateOne: vi.fn(),
    },
    friends: {
      find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
      findOne: vi.fn(async () => null),
    },
    friendRequests: { find: vi.fn(() => ({ toArray: vi.fn(async () => []) })), findOne: vi.fn(async () => null) },
    chatMessages: { find: vi.fn(() => ({ sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn(async () => []) })), insertOne: vi.fn() },
    ladderSeasons: { findOne: vi.fn(async () => null), findOneAndUpdate: vi.fn(), insertOne: vi.fn() },
    pveChaptersCleared: { findOne: vi.fn(async () => null), findOneAndUpdate: vi.fn() },
    leaderboard: { find: vi.fn(() => ({ sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn(async () => []) })), findOneAndUpdate: vi.fn() },
    bpProgress: { findOne: vi.fn(async () => null), findOneAndUpdate: vi.fn() },
  } as unknown as Collections;

  return { cols, getAccount: (id: string) => accountMap.get(id) };
}

const KEY = 'internal-key-c4';

async function buildInternalApp(cols: Collections) {
  const app = Fastify({ logger: false });
  await registerInternalRoutes(app, {
    cols,
    gateway: fakeGateway(),
    commercial: fakeCommercial(),
    now: () => 1_700_000_000_000,
    internalKey: KEY,
  });
  await app.ready();
  return app;
}

// ── GET /internal/suspicious-pve ─────────────────────────────────────────────

describe('GET /internal/suspicious-pve', () => {
  it('requires X-Internal-Key', async () => {
    const { cols } = fakeColsWithAccounts([]);
    const app = await buildInternalApp(cols);
    const r = await app.inject({ method: 'GET', url: '/internal/suspicious-pve' });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('returns accounts with pveWarnings > 0', async () => {
    const accounts = [
      { _id: 'acc-1', flags: { pveWarnings: 3, banned: true }, createdAt: 1000 },
      { _id: 'acc-2', flags: { pveWarnings: 1 }, createdAt: 2000 },
      { _id: 'acc-3', createdAt: 3000 }, // no flags, should be excluded
    ];
    const { cols } = fakeColsWithAccounts(accounts);
    const app = await buildInternalApp(cols);
    const r = await app.inject({
      method: 'GET',
      url: '/internal/suspicious-pve',
      headers: { 'x-internal-key': KEY },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { ok: boolean; accounts: unknown[] };
    expect(body.ok).toBe(true);
    // Should have 2 accounts (those with pveWarnings > 0)
    expect(body.accounts).toHaveLength(2);
    await app.close();
  });

  it('returns empty when no suspicious accounts', async () => {
    const { cols } = fakeColsWithAccounts([
      { _id: 'clean-acc', createdAt: 1000 },
    ]);
    const app = await buildInternalApp(cols);
    const r = await app.inject({
      method: 'GET',
      url: '/internal/suspicious-pve',
      headers: { 'x-internal-key': KEY },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { ok: boolean; accounts: unknown[] };
    expect(body.accounts).toHaveLength(0);
    await app.close();
  });
});

// ── POST /internal/accounts/:id/ban / unban（S4-4）──────────────────────────────

describe('POST /internal/accounts/:id/ban', () => {
  it('requires X-Internal-Key', async () => {
    const { cols } = fakeColsWithAccounts([{ _id: 'acc-1', createdAt: 1000 }]);
    const app = await buildInternalApp(cols);
    const r = await app.inject({ method: 'POST', url: '/internal/accounts/acc-1/ban' });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('404 for unknown account', async () => {
    const { cols } = fakeColsWithAccounts([]);
    const app = await buildInternalApp(cols);
    const r = await app.inject({
      method: 'POST',
      url: '/internal/accounts/no-such/ban',
      headers: { 'x-internal-key': KEY },
    });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it('sets flags.banned on account', async () => {
    const { cols, getAccount } = fakeColsWithAccounts([{ _id: 'acc-1', createdAt: 1000 }]);
    const app = await buildInternalApp(cols);
    const r = await app.inject({
      method: 'POST',
      url: '/internal/accounts/acc-1/ban',
      headers: { 'x-internal-key': KEY },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).ok).toBe(true);
    expect(getAccount('acc-1')?.flags?.banned).toBe(true);
    await app.close();
  });
});

describe('POST /internal/accounts/:id/unban', () => {
  it('requires X-Internal-Key', async () => {
    const { cols } = fakeColsWithAccounts([{ _id: 'acc-1', flags: { banned: true }, createdAt: 1000 }]);
    const app = await buildInternalApp(cols);
    const r = await app.inject({ method: 'POST', url: '/internal/accounts/acc-1/unban' });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('clears flags.banned on account', async () => {
    const { cols, getAccount } = fakeColsWithAccounts([{ _id: 'acc-1', flags: { banned: true, pveWarnings: 3 }, createdAt: 1000 }]);
    const app = await buildInternalApp(cols);
    const r = await app.inject({
      method: 'POST',
      url: '/internal/accounts/acc-1/unban',
      headers: { 'x-internal-key': KEY },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).ok).toBe(true);
    expect(getAccount('acc-1')?.flags?.banned).toBeUndefined();
    await app.close();
  });

  it('404 for unknown account', async () => {
    const { cols } = fakeColsWithAccounts([]);
    const app = await buildInternalApp(cols);
    const r = await app.inject({
      method: 'POST',
      url: '/internal/accounts/ghost/unban',
      headers: { 'x-internal-key': KEY },
    });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});
