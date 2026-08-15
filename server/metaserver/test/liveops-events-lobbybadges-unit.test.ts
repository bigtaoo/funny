// Unit-style coverage backfill for src/service/liveops/{events,lobbyBadges}.ts (2026-08-14 coverage task).
// Business logic for the underlying `src/events.ts` container functions (accrueEventTask/claimEventReward)
// is already exercised — WITH correct src coverage — by test/events-accrue.e2e.test.ts and
// test/events-claim.e2e.test.ts (both already import directly from '../src/events.js', not dist). The two
// files targeted here are the thin fastify-request/reply WRAPPERS around those functions
// (getEventsHandler/claimEventRewardHandler in service/liveops/events.ts) and the lobby aggregation
// (getLobbyBadgesHandler in service/liveops/lobbyBadges.ts) — neither gets any src attribution from the
// existing suite because test/lobby-badges.e2e.test.ts imports `buildApp` from '../dist/app.js' (compiled
// output; v8's coverage provider only attributes to src when vitest's own transform loaded the code), and
// no existing test drives events.ts's two HTTP handlers at all (only the underlying container functions).
//
// claimEventReward's atomic claim-count guard uses $elemMatch/$expr in its Mongo filters, which
// test/helpers/fakeCollection.ts's FakeCollection does not implement — real Mongo (the shared rs0 instance)
// is the pragmatic choice here, same as events-accrue.e2e.test.ts / events-claim.e2e.test.ts.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, makeWeekKey, type JwtConfig, type MongoHandle, type EventDoc } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { MetaSocialsvcClient } from '../src/socialsvcClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_events_lobbybadges_unit_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (e) {
    if (process.env.NW_REQUIRE_DB) throw e;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[liveops-events-lobbybadges-unit] Mongo unreachable (${URI}) — skipping.`);

/** Fake socialsvc: proxy() returns a canned /social/badges payload; toggled per test via `status`. */
class FakeSocialsvc implements MetaSocialsvcClient {
  available = true;
  status = 200;
  payload: unknown = { ok: true, data: { friendRequests: 1, chat: 2, mail: 3, total: 6 } };
  async proxy(_method: string, path: string) {
    if (path === '/social/badges') return { status: this.status, data: this.payload };
    return { status: 404, data: { ok: false, error: { code: 'NOT_FOUND', message: 'unknown path' } } };
  }
  async claimMail() {
    return { error: 'NOT_FOUND' as const };
  }
  async unclaimMail() {}
  async insertSystemMail(): Promise<never> {
    throw new Error('not used in this test');
  }
  async bulkInsertSystemMail(): Promise<never> {
    throw new Error('not used in this test');
  }
}

function seedEvent(overrides: Partial<EventDoc> = {}): EventDoc {
  return {
    _id: 'ev1',
    title: 'Unit Test Event',
    windowStart: 1_000_000,
    windowEnd: 2_000_000,
    tasks: [{ taskId: 'clear5', kind: 'pve.clear', target: 5, points: 100 }],
    rewards: [
      { rewardId: 'coin_reward', cost: 10, kind: 'coins', count: 50 },
      { rewardId: 'material_reward', cost: 10, kind: 'material', id: 'scrap', count: 3 },
      { rewardId: 'capped', cost: 10, kind: 'coins', count: 100, maxClaims: 1 },
    ],
    createdAt: 0,
    ...overrides,
  };
}

describe.skipIf(!mongo)('events.ts + lobbyBadges.ts (src import, real Mongo, coverage backfill)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  const NOW = 1_500_000; // inside seedEvent's default window

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  async function buildAndAuth(opts: Partial<Parameters<typeof buildApp>[0]> = {}): Promise<void> {
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', now: () => NOW, ...opts });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `dev-events-${Math.random()}` } }));
    token = r.data.token;
    await app.inject({ method: 'GET', url: '/save', headers: auth() });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  // ── GET /events ──────────────────────────────────────────────────────────────────────────────
  describe('GET /events (getEventsHandler)', () => {
    it('no active events -> empty list', async () => {
      await buildAndAuth();
      const r = body(await app.inject({ method: 'GET', url: '/events', headers: auth() }));
      expect(r.ok).toBe(true);
      expect(r.data.events).toEqual([]);
    });

    it('active event within window -> returned with defs + zeroed participation', async () => {
      await buildAndAuth();
      await m.collections.events.insertOne(seedEvent());
      const r = body(await app.inject({ method: 'GET', url: '/events', headers: auth() }));
      expect(r.ok).toBe(true);
      expect(r.data.events).toHaveLength(1);
      expect(r.data.events[0]).toMatchObject({ eventId: 'ev1', title: 'Unit Test Event', myPoints: 0 });
      expect(r.data.events[0].tasks[0]).toMatchObject({ taskId: 'clear5', progress: 0, done: false });
    });

    it('event outside the window (ended) -> not returned', async () => {
      await buildAndAuth();
      await m.collections.events.insertOne(seedEvent({ _id: 'ev-ended', windowStart: 0, windowEnd: 100 }));
      const r = body(await app.inject({ method: 'GET', url: '/events', headers: auth() }));
      expect(r.data.events).toEqual([]);
    });
  });

  // ── POST /events/claim ───────────────────────────────────────────────────────────────────────
  describe('POST /events/claim (claimEventRewardHandler)', () => {
    it('missing eventId/rewardId -> 400 BAD_REQUEST', async () => {
      await buildAndAuth();
      const r1 = await app.inject({ method: 'POST', url: '/events/claim', headers: auth(), payload: { rewardId: 'x' } });
      expect(r1.statusCode).toBe(400);
      const r2 = await app.inject({ method: 'POST', url: '/events/claim', headers: auth(), payload: { eventId: 'ev1' } });
      expect(r2.statusCode).toBe(400);
    });

    it('unknown eventId -> 404 NOT_FOUND', async () => {
      await buildAndAuth();
      const r = await app.inject({ method: 'POST', url: '/events/claim', headers: auth(), payload: { eventId: 'no-such-event', rewardId: 'x' } });
      expect(r.statusCode).toBe(404);
      expect(body(r).error.code).toBe('NOT_FOUND');
    });

    it('unknown rewardId on a real event -> 404 NOT_FOUND', async () => {
      await buildAndAuth();
      await m.collections.events.insertOne(seedEvent());
      const r = await app.inject({ method: 'POST', url: '/events/claim', headers: auth(), payload: { eventId: 'ev1', rewardId: 'no-such-reward' } });
      expect(r.statusCode).toBe(404);
    });

    it('event closed (outside window) -> 403 EVENT_CLOSED', async () => {
      await buildAndAuth();
      await m.collections.events.insertOne(seedEvent({ _id: 'ev-closed', windowStart: 0, windowEnd: 100 }));
      const r = await app.inject({ method: 'POST', url: '/events/claim', headers: auth(), payload: { eventId: 'ev-closed', rewardId: 'coin_reward' } });
      expect(r.statusCode).toBe(403);
      expect(body(r).error.code).toBe('BAD_REQUEST'); // EVENT_CLOSED maps to the generic BAD_REQUEST error code (see the handler's mapping table)
    });

    it('insufficient points (brand-new participant, cost=10, points=0) -> 402 INSUFFICIENT_FUNDS', async () => {
      await buildAndAuth();
      await m.collections.events.insertOne(seedEvent());
      const r = await app.inject({ method: 'POST', url: '/events/claim', headers: auth(), payload: { eventId: 'ev1', rewardId: 'coin_reward' } });
      expect(r.statusCode).toBe(402);
      expect(body(r).error.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('happy path (coins reward): commercial.grant delivers coins, pointsLeft debited', async () => {
      const comm = {
        available: true,
        grantCalls: [] as unknown[],
        async grant(a: unknown) {
          (this.grantCalls as unknown[]).push(a);
          return { ok: true as const, coinsAfter: 50 };
        },
      };
      await buildAndAuth({ commercial: comm as never });
      await m.collections.events.insertOne(seedEvent());
      const accountId = (body(await app.inject({ method: 'GET', url: '/save', headers: auth() }))).data.save.accountId;
      await m.collections.eventParticipants.updateOne(
        { _id: `ev1:${accountId}` },
        { $set: { _id: `ev1:${accountId}`, eventId: 'ev1', accountId, points: 100, taskProgress: [], claimedRewards: [], updatedAt: NOW } },
        { upsert: true },
      );
      const r = body(await app.inject({ method: 'POST', url: '/events/claim', headers: auth(), payload: { eventId: 'ev1', rewardId: 'coin_reward' } }));
      expect(r.ok).toBe(true);
      expect(r.data.pointsLeft).toBe(90);
      expect(r.data.reward).toMatchObject({ kind: 'coins', count: 50 });
      expect(comm.grantCalls.length).toBe(1);
    });

    it('happy path (material reward): dispatched via mail, not commercial', async () => {
      await buildAndAuth();
      await m.collections.events.insertOne(seedEvent());
      const accountId = (body(await app.inject({ method: 'GET', url: '/save', headers: auth() }))).data.save.accountId;
      await m.collections.eventParticipants.updateOne(
        { _id: `ev1:${accountId}` },
        { $set: { _id: `ev1:${accountId}`, eventId: 'ev1', accountId, points: 100, taskProgress: [], claimedRewards: [], updatedAt: NOW } },
        { upsert: true },
      );
      const r = body(await app.inject({ method: 'POST', url: '/events/claim', headers: auth(), payload: { eventId: 'ev1', rewardId: 'material_reward' } }));
      expect(r.ok).toBe(true);
      expect(r.data.reward).toMatchObject({ kind: 'material', id: 'scrap', count: 3 });
    });

    it('claim-limit reached (maxClaims:1, second claim) -> 409 ALREADY_CLAIMED', async () => {
      await buildAndAuth();
      await m.collections.events.insertOne(seedEvent());
      const accountId = (body(await app.inject({ method: 'GET', url: '/save', headers: auth() }))).data.save.accountId;
      await m.collections.eventParticipants.updateOne(
        { _id: `ev1:${accountId}` },
        { $set: { _id: `ev1:${accountId}`, eventId: 'ev1', accountId, points: 1000, taskProgress: [], claimedRewards: [], updatedAt: NOW } },
        { upsert: true },
      );
      const first = await app.inject({ method: 'POST', url: '/events/claim', headers: auth(), payload: { eventId: 'ev1', rewardId: 'capped' } });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: 'POST', url: '/events/claim', headers: auth(), payload: { eventId: 'ev1', rewardId: 'capped' } });
      expect(second.statusCode).toBe(409);
      expect(body(second).error.code).toBe('ALREADY_CLAIMED');
    });
  });

  // ── GET /lobby/badges (getLobbyBadgesHandler) ────────────────────────────────────────────────
  describe('GET /lobby/badges (getLobbyBadgesHandler)', () => {
    it('socialsvc not configured: social degrades to zeros; achievements/retention/events fields present', async () => {
      await buildAndAuth();
      const r = body(await app.inject({ method: 'GET', url: '/lobby/badges', headers: auth() }));
      expect(r.ok).toBe(true);
      expect(r.data.social).toEqual({ friendRequests: 0, chat: 0, mail: 0, total: 0 });
      expect(Array.isArray(r.data.achievements.defs)).toBe(true);
      expect(r.data.achievements.defs.length).toBeGreaterThan(0);
      expect(r.data.retentionClaimable).toEqual({ checkin: true, daily: false, weekly: false });
      expect(r.data.eventsAvailable).toBe(false);
    });

    it('socialsvc configured and healthy: social badges proxied through', async () => {
      const socialsvc = new FakeSocialsvc();
      await buildAndAuth({ socialsvc: socialsvc as never });
      const r = body(await app.inject({ method: 'GET', url: '/lobby/badges', headers: auth() }));
      expect(r.data.social).toEqual({ friendRequests: 1, chat: 2, mail: 3, total: 6 });
    });

    it('socialsvc configured but erroring (non-200): degrades to zeros instead of failing the whole response', async () => {
      const socialsvc = new FakeSocialsvc();
      socialsvc.status = 503;
      socialsvc.payload = { ok: false, error: { code: 'UNAVAILABLE', message: 'down' } };
      await buildAndAuth({ socialsvc: socialsvc as never });
      const r = body(await app.inject({ method: 'GET', url: '/lobby/badges', headers: auth() }));
      expect(r.ok).toBe(true);
      expect(r.data.social).toEqual({ friendRequests: 0, chat: 0, mail: 0, total: 0 });
    });

    it('an active event with points > 0 surfaces eventsAvailable = true', async () => {
      await buildAndAuth();
      await m.collections.events.insertOne(seedEvent());
      const r = body(await app.inject({ method: 'GET', url: '/lobby/badges', headers: auth() }));
      expect(r.data.eventsAvailable).toBe(true);
    });

    it('a reached-but-unclaimed weekly chest tier surfaces as retentionClaimable.weekly = true', async () => {
      await buildAndAuth();
      const doc = await m.collections.saves.findOne({});
      await m.collections.saves.updateOne(
        { _id: doc!._id },
        { $set: { 'save.retention.weekly': { weekKey: makeWeekKey(NOW), points: 9, claimedTiers: [] }, rev: doc!.rev + 1 } },
      );
      const r = body(await app.inject({ method: 'GET', url: '/lobby/badges', headers: auth() }));
      expect(r.data.retentionClaimable.weekly).toBe(true);
    });
  });
});
