// Branch-coverage backfill for the thin service layer (2026-09-03 branch-coverage task, group F):
// src/service/save.ts, src/service/progression.ts, src/service/social.ts, src/service/auth.ts.
//
// Why this file exists: these handlers are covered end-to-end elsewhere, but always through
// '../dist/app.js' (v8 cannot map that back to src/*.ts), and always in a configuration where the
// optional dependencies are absent — so every "dependency IS configured" side of a `?? fallback`, and
// every guard that a route's own schema makes unreachable, read as never-executed. Instead of another
// buildApp, this file constructs the domain services directly over a MetaCore (real Mongo where the
// logic needs Mongo operators FakeCollection does not model) so the request shape is fully controllable.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMongo,
  makeNewSave,
  type Collections,
  type JwtConfig,
  type MatchDoc,
  type MongoHandle,
} from '@nw/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MetaCore, type ServiceDeps } from '../src/service/base.js';
import { SaveService } from '../src/service/save.js';
import { ProgressionService } from '../src/service/progression.js';
import { SocialService } from '../src/service/social.js';
import { AuthService } from '../src/service/auth.js';
import { AccountCache } from '../src/accountCache.js';
import type { CommercialClient, WalletView } from '../src/commercialClient.js';
import type { MetaSocialsvcClient } from '../src/socialsvcClient.js';
import { FakeCollection } from './helpers/fakeCollection.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_grpF_branch_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const TS = 1_700_000_000_000;

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (e) {
    if (process.env.NW_REQUIRE_DB) throw e;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[accounts-core-branch-service] Mongo unreachable (${URI}) — skipping.`);

/** Minimal commercial double: only getWallet/undeliveredOrders/orderDelivered are on getSave's path. */
function commercialStub(available: boolean): CommercialClient {
  return {
    available,
    async getWallet(): Promise<WalletView> {
      return { coins: 0, pity: {}, fatePoints: 0, subscriptionExpiry: 0, starterUsed: [], firstPurchaseUsed: false, totalRechargeCents: 0 };
    },
    async undeliveredOrders() { return []; },
    async orderDelivered() { return { ok: true as const }; },
  } as unknown as CommercialClient;
}

interface ProxyCall { method: string; path: string; body: unknown; authorization: string }

/** socialsvc double that records every proxied call — the only way to see what auth header was forwarded. */
function socialsvcStub(available = true): MetaSocialsvcClient & { calls: ProxyCall[] } {
  const calls: ProxyCall[] = [];
  return {
    available,
    calls,
    async proxy(method: string, path: string, body: unknown, authorization: string) {
      calls.push({ method, path, body, authorization });
      return { status: 200, data: { ok: true } };
    },
    async claimMail() { throw new Error('not used'); },
    async unclaimMail() { /* not used */ },
    async insertSystemMail() { throw new Error('not used'); },
    async bulkInsertSystemMail() { throw new Error('not used'); },
  } as unknown as MetaSocialsvcClient & { calls: ProxyCall[] };
}

function makeDeps(cols: Collections, over: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    cols,
    jwt,
    now: () => TS,
    commercial: commercialStub(true),
    gatewayPublicUrl: null,
    gateway: { available: false } as unknown as ServiceDeps['gateway'],
    authRateLimit: 0,
    flags: null,
    wordlists: null,
    region: null,
    lokiPushUrl: null,
    socialsvc: null,
    redis: null,
    accountCache: new AccountCache(),
    ...over,
  } as unknown as ServiceDeps;
}

function fakeReq(over: Record<string, unknown> = {}): FastifyRequest {
  return {
    headers: {},
    params: {},
    query: {},
    body: {},
    log: { warn: () => {}, info: () => {}, error: () => {} },
    ...over,
  } as unknown as FastifyRequest;
}

function fakeReply(): FastifyReply & { sent: { status?: number; payload?: { ok?: boolean; error?: { code: string; message: string } } } } {
  const sent: { status?: number; payload?: { ok?: boolean; error?: { code: string; message: string } } } = {};
  const reply = {
    code(c: number) { sent.status = c; return reply; },
    status(c: number) { sent.status = c; return reply; },
    send(p: unknown) { sent.payload = p as never; return reply; },
    sent,
  };
  return reply as unknown as FastifyReply & { sent: typeof sent };
}

describe.skipIf(!mongo)('service-layer branch backfill (group F)', () => {
  const m = mongo!;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  // ── src/service/save.ts ───────────────────────────────────────────────────────────────────────
  describe('SaveService.getSave', () => {
    it('with socialsvc configured, the configured client (not the null stand-in) is threaded into reconcile/migration', async () => {
      // The `deps.socialsvc ?? nullMetaSocialsvcClient` fallbacks exist so a single-process deployment
      // still works; every existing test ran with socialsvc=null, so the configured side — the one that
      // actually reaches socialsvc in production — was never executed.
      const socialsvc = socialsvcStub();
      await m.collections.accounts.insertOne({ _id: 'acc-sv1', deviceId: 'dev-sv1', createdAt: TS } as never);
      const core = new MetaCore(makeDeps(m.collections, { socialsvc }));
      const svc = new SaveService(core);
      const r = await svc.getSave(fakeReq({ accountId: 'acc-sv1' })) as { ok: boolean; data: Record<string, unknown> };
      expect(r.ok).toBe(true);
      expect(r.data.publicId).toMatch(/^[1-9]\d{8}$/);
      expect(r.data.serverNow).toBe(TS);
      expect(r.data.freeRename).toBe(true);
    });

    it('with commercial unavailable the wallet reconcile is skipped entirely and the local save is served', async () => {
      await m.collections.accounts.insertOne({ _id: 'acc-sv2', deviceId: 'dev-sv2', createdAt: TS } as never);
      const core = new MetaCore(makeDeps(m.collections, { commercial: commercialStub(false) }));
      const r = await new SaveService(core).getSave(fakeReq({ accountId: 'acc-sv2' })) as { ok: boolean; data: Record<string, unknown> };
      expect(r.ok).toBe(true);
      expect((r.data.save as { accountId: string }).accountId).toBe('acc-sv2');
    });

    it('an account whose stored displayName is the empty string -> the field is omitted, not sent as ""', async () => {
      // Why this branch matters: the client treats a present-but-empty displayName as "the player has a
      // nickname and it is blank" and renders an empty name plate; omitting the field makes it fall back
      // to the publicId instead. Reachable only from a save whose displayName was written as '' (the
      // lazy backfill's $exists guard will not replace it), which no HTTP test ever produces.
      await m.collections.accounts.insertOne({ _id: 'acc-sv3', displayName: '', createdAt: TS } as never);
      const core = new MetaCore(makeDeps(m.collections));
      const r = await new SaveService(core).getSave(fakeReq({ accountId: 'acc-sv3' })) as { ok: boolean; data: Record<string, unknown> };
      expect(r.ok).toBe(true);
      expect('displayName' in r.data).toBe(false);
    });
  });

  describe('SaveService.getMatchHistory (limit clamping)', () => {
    async function seedMatches(accountId: string, count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        await m.collections.matches.insertOne({
          _id: `room-${i}`,
          roomId: `room-${i}`,
          mode: 'ranked',
          winner: i % 2,
          ts: TS + i,
          players: [
            { accountId, side: 0, displayName: 'Me', publicId: '111111111', eloDelta: 3 },
            { accountId: 'opp', side: 1, displayName: 'Rival', publicId: '222222222' },
          ],
        } as unknown as MatchDoc);
      }
    }

    it('a numeric limit is honoured and clamped into [1,50]', async () => {
      await seedMatches('acc-h1', 8);
      const svc = new SaveService(new MetaCore(makeDeps(m.collections)));
      const few = await svc.getMatchHistory(fakeReq({ accountId: 'acc-h1', query: { limit: '3' } })) as { data: { matches: unknown[] } };
      expect(few.data.matches).toHaveLength(3);
      // 0 and negative clamp up to 1 rather than returning an empty page.
      const one = await svc.getMatchHistory(fakeReq({ accountId: 'acc-h1', query: { limit: -5 } })) as { data: { matches: unknown[] } };
      expect(one.data.matches).toHaveLength(1);
    });

    it('a non-numeric / absent limit falls back to 20 instead of NaN-ing the cursor', async () => {
      await seedMatches('acc-h2', 3);
      const svc = new SaveService(new MetaCore(makeDeps(m.collections)));
      const noQuery = await svc.getMatchHistory(fakeReq({ accountId: 'acc-h2' })) as { data: { matches: unknown[] } };
      expect(noQuery.data.matches).toHaveLength(3);
      const junk = await svc.getMatchHistory(fakeReq({ accountId: 'acc-h2', query: { limit: 'abc' } })) as { data: { matches: unknown[] } };
      expect(junk.data.matches).toHaveLength(3);
    });

    it('opponent name/publicId/eloDelta are omitted when the archived row does not carry them', async () => {
      await m.collections.matches.insertOne({
        _id: 'room-bare', roomId: 'room-bare', mode: 'friendly', winner: -1, ts: TS,
        players: [{ accountId: 'acc-h3', side: 0 }, { accountId: 'opp2', side: 1 }],
      } as unknown as MatchDoc);
      const svc = new SaveService(new MetaCore(makeDeps(m.collections)));
      const r = await svc.getMatchHistory(fakeReq({ accountId: 'acc-h3' })) as { data: { matches: Record<string, unknown>[] } };
      expect(r.data.matches[0]).toEqual({ roomId: 'room-bare', mode: 'friendly', result: 'unknown', ts: TS });
    });
  });

  describe('SaveService.getMatchReplay', () => {
    it('a request with no roomId param -> 404 rather than querying with roomId undefined', async () => {
      // The route schema makes this unreachable over HTTP, but the guard is what stops a
      // `findOne({roomId: undefined})` from matching an arbitrary document and leaking someone else's
      // replay if the route is ever re-declared with an optional param.
      const reply = fakeReply();
      const svc = new SaveService(new MetaCore(makeDeps(m.collections)));
      await svc.getMatchReplay(fakeReq({ accountId: 'acc-r1', params: {} }), reply);
      expect(reply.sent.status).toBe(404);
      expect(reply.sent.payload?.error?.code).toBe('NOT_FOUND');
    });

    it('a match the caller did not participate in -> 404 (not 403), so replay ids are not enumerable', async () => {
      await m.collections.matches.insertOne({
        _id: 'room-x', roomId: 'room-x', mode: 'ranked', winner: 0, ts: TS,
        players: [{ accountId: 'someone-else', side: 0 }],
      } as unknown as MatchDoc);
      const reply = fakeReply();
      const svc = new SaveService(new MetaCore(makeDeps(m.collections)));
      await svc.getMatchReplay(fakeReq({ accountId: 'acc-r2', params: { roomId: 'room-x' } }), reply);
      expect(reply.sent.status).toBe(404);
    });
  });

  // ── src/service/progression.ts ────────────────────────────────────────────────────────────────
  describe('ProgressionService.getLeaderboard', () => {
    it('a top-100 row whose accounts document is gone renders with blank name/publicId instead of failing the whole board', async () => {
      // Hard-deleted (GDPR erasure) or not-yet-created account rows must not take the leaderboard down
      // for everyone else — the join is a left join and the two `?? ''` fallbacks are what make it one.
      const named = makeNewSave('acc-named', TS);
      named.pvp.elo = 1500;
      const orphan = makeNewSave('acc-orphan', TS);
      orphan.pvp.elo = 1400;
      await m.collections.saves.insertOne({ _id: 'acc-named', save: named, rev: named.rev } as never);
      await m.collections.saves.insertOne({ _id: 'acc-orphan', save: orphan, rev: orphan.rev } as never);
      await m.collections.accounts.insertOne({ _id: 'acc-named', displayName: 'Wei', publicId: '123456789', createdAt: TS } as never);

      const svc = new ProgressionService(new MetaCore(makeDeps(m.collections)));
      const r = await svc.getLeaderboard(fakeReq({ accountId: 'acc-named' })) as {
        data: { entries: { rank: number; displayName: string; publicId: string }[]; me?: { rank: number } };
      };
      expect(r.data.entries[0]).toMatchObject({ rank: 1, displayName: 'Wei', publicId: '123456789' });
      expect(r.data.entries[1]).toMatchObject({ rank: 2, displayName: '', publicId: '' });
      expect(r.data.me).toEqual({ rank: 1, elo: 1500, pvpRank: expect.any(String) });
    });

    it('a caller with no save for this season gets entries but no `me` standing', async () => {
      const svc = new ProgressionService(new MetaCore(makeDeps(m.collections)));
      const r = await svc.getLeaderboard(fakeReq({ accountId: 'acc-never-played' })) as { data: Record<string, unknown> };
      expect(r.data.entries).toEqual([]);
      expect('me' in r.data).toBe(false);
    });
  });

  describe('ProgressionService.submitBotResult', () => {
    it('happy path: ELO moves and the response carries the applied delta', async () => {
      const save = makeNewSave('acc-b1', TS);
      await m.collections.saves.insertOne({ _id: 'acc-b1', save, rev: save.rev } as never);
      const svc = new ProgressionService(new MetaCore(makeDeps(m.collections)));
      const reply = fakeReply();
      const r = await svc.submitBotResult(fakeReq({ accountId: 'acc-b1', body: { won: true } }), reply) as {
        data: { elo: number; delta: number };
      };
      expect(reply.sent.status).toBeUndefined();
      expect(r.data.delta).toBeGreaterThan(0);
      expect(r.data.elo).toBe(save.pvp.elo + r.data.delta);
    });

    it('every CAS attempt lost -> 409 REV_CONFLICT and the stored ELO is untouched', async () => {
      // Two bot results reported in the same instant (a client retrying a slow POST): the loser must
      // surface a retryable 409, never a partially applied ELO change.
      const save = makeNewSave('acc-b2', TS);
      await m.collections.saves.insertOne({ _id: 'acc-b2', save, rev: save.rev } as never);
      vi.spyOn(m.collections.saves, 'findOneAndUpdate').mockResolvedValue(null as never);
      const reply = fakeReply();
      const svc = new ProgressionService(new MetaCore(makeDeps(m.collections)));
      await svc.submitBotResult(fakeReq({ accountId: 'acc-b2', body: { won: true } }), reply);
      expect(reply.sent.status).toBe(409);
      expect(reply.sent.payload?.error?.code).toBe('REV_CONFLICT');
      vi.restoreAllMocks();
      expect((await m.collections.saves.findOne({ _id: 'acc-b2' }))!.save.pvp.elo).toBe(save.pvp.elo);
    });
  });

  // ── src/service/social.ts ─────────────────────────────────────────────────────────────────────
  describe('SocialService.proxySocial', () => {
    it('socialsvc not configured -> 503 NOT_IMPLEMENTED, nothing proxied', async () => {
      const reply = fakeReply();
      await new SocialService(new MetaCore(makeDeps(m.collections, { socialsvc: null }))).getFriends(fakeReq({ accountId: 'a' }), reply);
      expect(reply.sent.status).toBe(503);
      expect(reply.sent.payload?.error?.code).toBe('NOT_IMPLEMENTED');
    });

    it('socialsvc present but marked unavailable -> also 503 (a downed dependency is not a 500)', async () => {
      const reply = fakeReply();
      const socialsvc = socialsvcStub(false);
      await new SocialService(new MetaCore(makeDeps(m.collections, { socialsvc }))).getFriends(fakeReq({ accountId: 'a' }), reply);
      expect(reply.sent.status).toBe(503);
      expect(socialsvc.calls).toHaveLength(0);
    });

    it('a request with no Authorization header proxies an empty string, not the literal "undefined"', async () => {
      // socialsvc re-verifies the JWT itself; forwarding `undefined` would stringify into the header and
      // be reported as a malformed token rather than a missing one.
      const socialsvc = socialsvcStub();
      const reply = fakeReply();
      await new SocialService(new MetaCore(makeDeps(m.collections, { socialsvc })))
        .getFriends(fakeReq({ accountId: 'a', method: 'GET', headers: {} }), reply);
      expect(socialsvc.calls[0]).toMatchObject({ path: '/social/friends', authorization: '', body: null });
      expect(reply.sent.status).toBe(200);
    });

    it('the caller\'s Authorization header is passed through verbatim', async () => {
      const socialsvc = socialsvcStub();
      await new SocialService(new MetaCore(makeDeps(m.collections, { socialsvc })))
        .getFriends(fakeReq({ accountId: 'a', method: 'GET', headers: { authorization: 'Bearer tok' } }), fakeReply());
      expect(socialsvc.calls[0]!.authorization).toBe('Bearer tok');
    });
  });

  describe('SocialService.getMessages (query-string assembly)', () => {
    it('no before/limit -> no trailing "?" is appended to the socialsvc path', async () => {
      const socialsvc = socialsvcStub();
      await new SocialService(new MetaCore(makeDeps(m.collections, { socialsvc })))
        .getMessages(fakeReq({ accountId: 'a', method: 'GET', params: { convId: 'c 1' }, query: {} }), fakeReply());
      expect(socialsvc.calls[0]!.path).toBe('/social/chat/c%201/messages');
    });

    it('before and limit are forwarded as a query string on the escaped conversation path', async () => {
      const socialsvc = socialsvcStub();
      await new SocialService(new MetaCore(makeDeps(m.collections, { socialsvc })))
        .getMessages(fakeReq({ accountId: 'a', method: 'GET', params: { convId: 'c1' }, query: { before: 42, limit: '10' } }), fakeReply());
      expect(socialsvc.calls[0]!.path).toBe('/social/chat/c1/messages?before=42&limit=10');
    });
  });

  // ── src/service/auth.ts ───────────────────────────────────────────────────────────────────────
  describe('AuthService auth-attempt rate limiting', () => {
    it('requests with no resolvable IP share the single "unknown" bucket instead of bypassing the limit', async () => {
      // req.ip is always set behind fastify, but the fallback is what keeps the limiter from keying every
      // such request under `undefined` (one shared bucket that then never rate-limits anyone).
      const accounts = new FakeCollection<{ _id: string }>();
      const cols = { accounts } as unknown as Collections;
      const svc = new AuthService(new MetaCore(makeDeps(cols, { authRateLimit: 1 })));

      const first = fakeReply();
      await svc.authRegister(fakeReq({ body: { loginId: 'x', password: 'short' } }), first);
      expect(first.sent.status).toBe(400); // consumed the single allowed attempt, then failed validation

      const second = fakeReply();
      await svc.authRegister(fakeReq({ body: { loginId: 'x', password: 'short' } }), second);
      expect(second.sent.status).toBe(429);
      expect(second.sent.payload?.error?.code).toBe('RATE_LIMITED');
    });

    it('authRateLimit=0 disables the limiter entirely (tests/CI configuration)', async () => {
      const accounts = new FakeCollection<{ _id: string }>();
      const svc = new AuthService(new MetaCore(makeDeps({ accounts } as unknown as Collections, { authRateLimit: 0 })));
      for (let i = 0; i < 3; i++) {
        const reply = fakeReply();
        await svc.authRegister(fakeReq({ body: { loginId: 'x', password: 'short' } }), reply);
        expect(reply.sent.status).toBe(400); // never 429
      }
    });
  });
});
