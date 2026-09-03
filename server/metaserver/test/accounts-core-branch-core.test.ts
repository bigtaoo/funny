// Branch-coverage backfill for the cross-cutting service core (2026-09-03 branch-coverage task, group F):
// src/service/base.ts (MetaCore + accountIdOf/clientPlatformOf), src/accountCache.ts's TTL/sweep paths,
// and src/auth.ts's bearerAuth security handler.
//
// Why this file exists: MetaCore is the single most-called class in metaserver (every domain calls
// mutateSave/rejectIfBanned/gatewayField) yet it had no dedicated unit test at all — its coverage came
// entirely from e2e suites that import '../dist/app.js', which v8 cannot attribute back to src/*.ts.
// Worse, an e2e test structurally cannot produce the branches that matter most here: a lost
// findOneAndUpdate CAS race, a save row that vanishes between the create and the read-back, or a
// TTL-expired cache entry. Those are driven directly below by wrapping one collection method.
import { describe, expect, it, vi } from 'vitest';
import {
  makeNewSave,
  signToken,
  type Collections,
  type RedisLike,
  type SaveData,
} from '@nw/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  MetaCore,
  STAMINA_CAP,
  STAMINA_REGEN_MS,
  accountIdOf,
  clientPlatformOf,
  type ServiceDeps,
} from '../src/service/base.js';
import { AccountCache } from '../src/accountCache.js';
import { makeSecurityHandlers } from '../src/auth.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeCommercial } from './helpers/fakeClients.js';

const TS = 1_700_000_000_000;
const jwt = { secret: 'test-secret' };

type SaveDoc = { _id: string; save: SaveData; rev: number };
type AccountDoc = { _id: string; flags?: { banned?: boolean; bannedUntil?: number }; deletedAt?: number };
type StaminaDoc = { _id: string; current: number; regenAt: number };

interface Fakes {
  core: MetaCore;
  saves: FakeCollection<SaveDoc>;
  accounts: FakeCollection<AccountDoc>;
  pveStamina: FakeCollection<StaminaDoc>;
  cols: Collections;
}

function makeCore(over: Partial<ServiceDeps> = {}, savesOverride?: FakeCollection<SaveDoc>): Fakes {
  const saves = savesOverride ?? new FakeCollection<SaveDoc>();
  const accounts = new FakeCollection<AccountDoc>();
  const pveStamina = new FakeCollection<StaminaDoc>();
  const cols = { saves, accounts, pveStamina } as unknown as Collections;
  const deps = {
    cols,
    jwt,
    now: () => TS,
    commercial: fakeCommercial(),
    gatewayPublicUrl: null,
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
  return { core: new MetaCore(deps), saves, accounts, pveStamina, cols };
}

function fakeReply(): FastifyReply & { sent: { status?: number; payload?: { error?: { code: string } } } } {
  const sent: { status?: number; payload?: { error?: { code: string } } } = {};
  const reply = {
    code(c: number) { sent.status = c; return reply; },
    status(c: number) { sent.status = c; return reply; },
    send(p: unknown) { sent.payload = p as { error?: { code: string } }; return reply; },
    sent,
  };
  return reply as unknown as FastifyReply & { sent: typeof sent };
}

// ── accountIdOf / clientPlatformOf ──────────────────────────────────────────────────────────────
describe('accountIdOf', () => {
  it('returns the id the security handler wrote', () => {
    expect(accountIdOf({ accountId: 'acc-1' } as FastifyRequest)).toBe('acc-1');
  });

  it('throws when the security handler never ran (a route wired without bearerAuth)', () => {
    // A silent `undefined` accountId would let a handler read/write another account's documents under a
    // key of `undefined`; failing loudly is the point of this guard.
    expect(() => accountIdOf({} as FastifyRequest)).toThrow('accountId missing after auth');
  });
});

describe('clientPlatformOf (X-NW-Platform -> commercial spend bucket)', () => {
  const of = (headers: Record<string, unknown>) => clientPlatformOf({ headers } as unknown as FastifyRequest);

  it('a non-empty string header is forwarded verbatim', () => {
    expect(of({ 'x-nw-platform': 'ios' })).toBe('ios');
  });

  it('absent / empty / repeated (array-valued) header -> undefined, so commercial defaults to the web bucket', () => {
    expect(of({})).toBeUndefined();
    expect(of({ 'x-nw-platform': '' })).toBeUndefined();
    // A duplicated header arrives as string[] from Node; forwarding an array as `clientPlatform` would
    // mean a client could pick an arbitrary recharged-pool bucket shape, so it must degrade to undefined.
    expect(of({ 'x-nw-platform': ['ios', 'web'] })).toBeUndefined();
  });
});

// ── gatewayField / activeMatchFieldFor ──────────────────────────────────────────────────────────
describe('MetaCore.gatewayField', () => {
  it('configured -> { gatewayUrl }; unconfigured -> {} (client falls back to its own config)', () => {
    expect(makeCore({ gatewayPublicUrl: 'wss://gw.example/ws' }).core.gatewayField).toEqual({ gatewayUrl: 'wss://gw.example/ws' });
    expect(makeCore({ gatewayPublicUrl: null }).core.gatewayField).toEqual({});
  });
});

describe('MetaCore.activeMatchFieldFor (login-reconnect prompt)', () => {
  it('no redis configured -> {} (feature disabled, login still works)', async () => {
    expect(await makeCore({ redis: null }).core.activeMatchFieldFor('acc-1')).toEqual({});
  });

  it('a cached ticket -> { activeMatch }, so the client can offer "resume your match?"', async () => {
    const record = { roomId: 'r1', gameUrl: 'wss://gs/ws', ticket: 't', mode: 'ranked' as const };
    const redis = { get: async () => JSON.stringify(record) } as unknown as RedisLike;
    expect(await makeCore({ redis }).core.activeMatchFieldFor('acc-1')).toEqual({ activeMatch: record });
  });

  it('redis configured but no entry for this account -> {}', async () => {
    const redis = { get: async () => null } as unknown as RedisLike;
    expect(await makeCore({ redis }).core.activeMatchFieldFor('acc-1')).toEqual({});
  });
});

// ── ensureCommercial ────────────────────────────────────────────────────────────────────────────
describe('MetaCore.ensureCommercial', () => {
  it('available -> true, nothing sent', () => {
    const reply = fakeReply();
    expect(makeCore({ commercial: fakeCommercial(true) }).core.ensureCommercial(reply)).toBe(true);
    expect(reply.sent.status).toBeUndefined();
  });

  it('unavailable -> 503 NOT_IMPLEMENTED and false (economy endpoints refuse rather than serving a mirror)', () => {
    const reply = fakeReply();
    expect(makeCore({ commercial: fakeCommercial(false) }).core.ensureCommercial(reply)).toBe(false);
    expect(reply.sent.status).toBe(503);
    expect(reply.sent.payload?.error?.code).toBe('NOT_IMPLEMENTED');
  });
});

// ── rejectIfBanned ──────────────────────────────────────────────────────────────────────────────
describe('MetaCore.rejectIfBanned', () => {
  async function check(doc: AccountDoc | null, now = TS): Promise<{ blocked: boolean; status?: number; code?: string }> {
    const f = makeCore({ now: () => now });
    if (doc) f.accounts.seed(doc);
    const reply = fakeReply();
    const blocked = await f.core.rejectIfBanned(f.cols, doc?._id ?? 'ghost', reply);
    return { blocked, status: reply.sent.status, code: reply.sent.payload?.error?.code };
  }

  it('clean account -> not blocked', async () => {
    expect(await check({ _id: 'a', flags: { banned: false } })).toEqual({ blocked: false, status: undefined, code: undefined });
  });

  it('missing account row -> not blocked (auth already proved the token; a stale row is not a ban)', async () => {
    expect((await check(null)).blocked).toBe(false);
  });

  it('soft-deleted -> 410 ACCOUNT_DELETED (checked before ban, so a deleted account never reads as merely banned)', async () => {
    expect(await check({ _id: 'a', deletedAt: TS - 1 })).toEqual({ blocked: true, status: 410, code: 'ACCOUNT_DELETED' });
  });

  it('permanently banned -> 403 ACCOUNT_BANNED', async () => {
    expect(await check({ _id: 'a', flags: { banned: true } })).toEqual({ blocked: true, status: 403, code: 'ACCOUNT_BANNED' });
  });

  it('temp ban still in the future -> 403 ACCOUNT_BANNED', async () => {
    expect(await check({ _id: 'a', flags: { bannedUntil: TS + 60_000 } })).toEqual({ blocked: true, status: 403, code: 'ACCOUNT_BANNED' });
  });

  it('temp ban already elapsed -> not blocked (CM6: auto-expires, no unban action needed)', async () => {
    expect((await check({ _id: 'a', flags: { bannedUntil: TS - 1 } })).blocked).toBe(false);
  });
});

// ── mutateSave ──────────────────────────────────────────────────────────────────────────────────
describe('MetaCore.mutateSave (optimistic-lock read-modify-write)', () => {
  it('existing doc: hot path takes one read, writes rev+1 and the new updatedAt', async () => {
    const stored = makeNewSave('acc-m1', TS - 1000);
    const f = makeCore({ now: () => TS });
    f.saves.seed({ _id: 'acc-m1', save: stored, rev: stored.rev });
    const out = await f.core.mutateSave('acc-m1', (s) => ({ ...s, wallet: { coins: 9 } }));
    expect(out).toEqual({ save: expect.objectContaining({ rev: stored.rev + 1, updatedAt: TS }) });
    expect(f.saves.docs.get('acc-m1')!.save.wallet.coins).toBe(9);
  });

  it('first-ever touch: the doc is lazily created by getOrCreateSave, then mutated', async () => {
    const f = makeCore();
    const out = await f.core.mutateSave('acc-fresh', (s) => ({ ...s, wallet: { coins: 1 } }));
    expect('save' in out && out.save.wallet.coins).toBe(1);
    expect(f.saves.docs.get('acc-fresh')).toBeDefined();
  });

  it('transform returning a business error code short-circuits without any write', async () => {
    const stored = makeNewSave('acc-m2', TS);
    const f = makeCore();
    f.saves.seed({ _id: 'acc-m2', save: stored, rev: stored.rev });
    expect(await f.core.mutateSave('acc-m2', () => 'INSUFFICIENT_FUNDS')).toEqual({ error: 'INSUFFICIENT_FUNDS' });
    expect(f.saves.docs.get('acc-m2')!.rev).toBe(stored.rev); // untouched
  });

  it('the doc is still unreadable after getOrCreateSave -> NOT_FOUND instead of dereferencing undefined', async () => {
    // Reads that never see the doc they just created (a read routed to a lagging secondary). The player's
    // mutation must be refused cleanly, not crash the request with a TypeError.
    class BlindSaves extends FakeCollection<SaveDoc> {
      override async findOne(): Promise<SaveDoc | null> { return null; }
    }
    const f = makeCore({}, new BlindSaves());
    let transformRuns = 0;
    const out = await f.core.mutateSave('acc-blind', (s) => { transformRuns++; return s; });
    expect(out).toEqual({ error: 'NOT_FOUND' });
    expect(transformRuns).toBe(0);
  });

  it('one lost CAS race -> re-reads the winner\'s document and re-applies the transform on top of it', async () => {
    // The shape an e2e test cannot produce: two writers reaching findOneAndUpdate in the same instant.
    // The loser must NOT overwrite the winner — it re-reads and re-runs the transform, so the winner's
    // coins survive and this caller's delta is applied on top.
    const stored = makeNewSave('acc-cas', TS);
    stored.wallet.coins = 100;
    const f = makeCore();
    f.saves.seed({ _id: 'acc-cas', save: stored, rev: stored.rev });
    const real = f.saves.findOneAndUpdate.bind(f.saves);
    let lost = false;
    vi.spyOn(f.saves, 'findOneAndUpdate').mockImplementation(async (filter, update, opts) => {
      if (!lost) {
        lost = true;
        // Simulate the concurrent winner landing first: it bumped rev and added 50 coins.
        const doc = f.saves.docs.get('acc-cas')!;
        doc.save = { ...doc.save, wallet: { coins: 150 }, rev: doc.save.rev + 1 };
        doc.rev = doc.save.rev;
        return null; // our own CAS on the stale rev misses
      }
      return real(filter, update, opts);
    });

    const seen: number[] = [];
    const out = await f.core.mutateSave('acc-cas', (s) => {
      seen.push(s.wallet.coins);
      return { ...s, wallet: { coins: s.wallet.coins + 5 } };
    });
    expect(seen).toEqual([100, 150]); // second run saw the winner's value, not the stale one
    expect('save' in out && out.save.wallet.coins).toBe(155);
  });

  it('four consecutive lost races -> REV_CONFLICT (the caller surfaces 409 rather than looping forever)', async () => {
    const stored = makeNewSave('acc-thrash', TS);
    const f = makeCore();
    f.saves.seed({ _id: 'acc-thrash', save: stored, rev: stored.rev });
    vi.spyOn(f.saves, 'findOneAndUpdate').mockResolvedValue(null);
    let transformRuns = 0;
    const out = await f.core.mutateSave('acc-thrash', (s) => { transformRuns++; return s; });
    expect(out).toEqual({ error: 'REV_CONFLICT' });
    expect(transformRuns).toBe(4);
  });
});

// ── readStaminaSnapshot ─────────────────────────────────────────────────────────────────────────
describe('MetaCore.readStaminaSnapshot (A4 natural regen)', () => {
  async function snap(doc: StaminaDoc | null, now: number) {
    const f = makeCore();
    if (doc) f.pveStamina.seed(doc);
    return f.core.readStaminaSnapshot(doc?._id ?? 'ghost', now);
  }

  it('no row yet -> full stamina, no timer (absent = never spent any)', async () => {
    expect(await snap(null, TS)).toEqual({ current: STAMINA_CAP, regenAt: 0 });
  });

  it('already at cap -> returned verbatim, no regen arithmetic', async () => {
    expect(await snap({ _id: 'a', current: STAMINA_CAP, regenAt: 0 }, TS + STAMINA_REGEN_MS * 10)).toEqual({ current: STAMINA_CAP, regenAt: 0 });
  });

  it('below cap but regenAt=0 -> no regen (a 0 timer would otherwise regen from the epoch, handing out the full bar)', async () => {
    expect(await snap({ _id: 'a', current: 5, regenAt: 0 }, TS)).toEqual({ current: 5, regenAt: 0 });
  });

  it('below cap and the next tick has not arrived -> unchanged', async () => {
    expect(await snap({ _id: 'a', current: 5, regenAt: TS + 1000 }, TS)).toEqual({ current: 5, regenAt: TS + 1000 });
  });

  it('below cap, two ticks elapsed -> +2 and the timer advances by exactly those ticks', async () => {
    const regenAt = TS;
    const out = await snap({ _id: 'a', current: 5, regenAt }, TS + STAMINA_REGEN_MS + 1);
    expect(out).toEqual({ current: 7, regenAt: regenAt + 2 * STAMINA_REGEN_MS });
  });

  it('enough ticks to refill -> clamped at the cap and the timer is cleared to 0', async () => {
    const out = await snap({ _id: 'a', current: STAMINA_CAP - 1, regenAt: TS }, TS + STAMINA_REGEN_MS * 500);
    expect(out).toEqual({ current: STAMINA_CAP, regenAt: 0 });
  });
});

// ── bumpRetentionTask ───────────────────────────────────────────────────────────────────────────
describe('MetaCore.bumpRetentionTask (B5 daily task, fire-and-forget)', () => {
  it('first call records the task; the second call for the same day is a content no-op', async () => {
    const stored = makeNewSave('acc-r1', TS);
    const f = makeCore();
    f.saves.seed({ _id: 'acc-r1', save: stored, rev: stored.rev });

    await f.core.bumpRetentionTask('acc-r1', 'pve.clear');
    const afterFirst = f.saves.docs.get('acc-r1')!.save.retention;
    expect(afterFirst?.daily?.completedTasks['pve.clear']).toBeGreaterThan(0);

    await f.core.bumpRetentionTask('acc-r1', 'pve.clear');
    // The no-op branch: accrueRetentionTask returned the identical object, so the transform hands the
    // save back untouched — the player's task points must not be counted twice.
    expect(f.saves.docs.get('acc-r1')!.save.retention).toEqual(afterFirst);
  });
});

// ── accountCache TTL / sweep ────────────────────────────────────────────────────────────────────
describe('AccountCache TTL expiry + piggybacked sweep', () => {
  it('a ban-status entry older than its TTL is re-queried, and a fresh one is still served from cache', async () => {
    // Why this matters: BAN_STATUS_TTL_MS is the safety net for a future write site that forgets to call
    // invalidateBanStatus — without the expiry check a stale "not banned" would be served forever.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(TS);
      const accounts = new FakeCollection<AccountDoc>().seed(
        { _id: 'a', flags: { banned: false } },
        { _id: 'b' },
        { _id: 'c' },
      );
      const cols = { accounts } as unknown as Collections;
      const spy = vi.spyOn(accounts, 'findOne');
      const cache = new AccountCache();

      expect((await cache.getBanStatus(cols, 'a')).banned).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);

      // 30s in: still inside the TTL for 'a'; 'b' is a cold miss (its set() call finds the sweep
      // interval not yet elapsed and returns early).
      vi.setSystemTime(TS + 30_000);
      expect((await cache.getBanStatus(cols, 'a')).banned).toBe(false);
      await cache.getBanStatus(cols, 'b');
      expect(spy).toHaveBeenCalledTimes(2); // only 'b' hit Mongo

      // 61s in: 'a' is past its TTL -> evicted on read and re-queried, this time picking up the ban an
      // admin wrote behind the cache's back. The set() that follows also runs the first real sweep pass
      // (which sees 'b' still fresh and keeps it).
      accounts.docs.get('a')!.flags = { banned: true };
      vi.setSystemTime(TS + 61_000);
      expect((await cache.getBanStatus(cols, 'a')).banned).toBe(true);
      expect(spy).toHaveBeenCalledTimes(3);

      // 130s in: 'a' (re-cached at 61s) and 'b' (cached at 30s) are both stale; this miss's set() sweeps
      // them out instead of leaving one-shot accounts resident for the life of the process.
      vi.setSystemTime(TS + 130_000);
      await cache.getBanStatus(cols, 'c');
      expect(spy).toHaveBeenCalledTimes(4);
      expect((await cache.getBanStatus(cols, 'b')).banned).toBe(false);
      expect(spy).toHaveBeenCalledTimes(5); // 'b' was gone -> re-queried
    } finally {
      vi.useRealTimers();
    }
  });

  it('bannedUntil is surfaced from the cached entry (temp bans survive the cache layer)', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({ _id: 'a', flags: { bannedUntil: TS + 5 } });
    const cache = new AccountCache();
    expect(await cache.getBanStatus({ accounts } as unknown as Collections, 'a')).toEqual({
      banned: false, deletedAt: undefined, bannedUntil: TS + 5,
    });
  });
});

// ── bearerAuth (src/auth.ts) ────────────────────────────────────────────────────────────────────
describe('makeSecurityHandlers().bearerAuth', () => {
  const handlers = makeSecurityHandlers(jwt);

  it('a valid token writes req.accountId', () => {
    const req = { headers: { authorization: `Bearer ${signToken('acc-1', jwt)}` } } as unknown as FastifyRequest;
    handlers.bearerAuth(req);
    expect(req.accountId).toBe('acc-1');
  });

  it('no Authorization header -> 401 UNAUTHENTICATED ("missing bearer token")', () => {
    const req = { headers: {} } as unknown as FastifyRequest;
    expect(() => handlers.bearerAuth(req)).toThrow('missing bearer token');
  });

  it('a malformed/forged token -> 401 UNAUTHENTICATED ("invalid token"), never a 500', () => {
    // verifyToken throws on a bad signature/shape; that must surface as an auth failure, not an
    // unhandled 500 (fastify-openapi-glue reads the statusCode/name off the thrown error).
    const req = { headers: { authorization: 'Bearer not-a-jwt' } } as unknown as FastifyRequest;
    let thrown: (Error & { statusCode?: number }) | undefined;
    try {
      handlers.bearerAuth(req);
    } catch (e) {
      thrown = e as Error & { statusCode?: number };
    }
    expect(thrown?.message).toBe('invalid token');
    expect(thrown?.statusCode).toBe(401);
    expect(thrown?.name).toBe('UNAUTHENTICATED');
    expect(req.accountId).toBeUndefined();
  });

  it('a token signed with a different secret -> "invalid token"', () => {
    const req = { headers: { authorization: `Bearer ${signToken('acc-1', { secret: 'other-secret' })}` } } as unknown as FastifyRequest;
    expect(() => handlers.bearerAuth(req)).toThrow('invalid token');
  });
});
