// GET /lobby/badges end-to-end (P1-4, comm-audit-2026-07-27): real Mongo + fastify-openapi-glue
// serialization. This aggregated endpoint replaces goLobby()'s old 4-request waterfall
// (getSocialBadges/getAchievements/getRetention/getEvents); the regression this guards against is the
// P0-audit bug class where a field present in the handler's return value but missing from the OpenAPI
// response schema gets silently stripped to `undefined` by fastify's schema-based serialization.
// Requires `cd server && docker compose up -d` + prior `tsc -b` (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, makeWeekKey, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { MetaSocialsvcClient } from '../dist/socialsvcClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_lobby_badges_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[lobby-badges.e2e] Mongo unreachable (${URI}) — skipping.`);

/** Fake socialsvc: proxy() returns a canned /social/badges payload; available toggled per test. */
class FakeSocialsvc implements MetaSocialsvcClient {
  available = true;
  async proxy(_method: string, path: string) {
    if (path === '/social/badges') {
      return { status: 200, data: { ok: true, data: { friendRequests: 1, chat: 2, mail: 3, total: 6 } } };
    }
    return { status: 404, data: { ok: false, error: { code: 'NOT_FOUND', message: 'unknown path' } } };
  }
  async claimMail() { return { error: 'NOT_FOUND' as const }; }
  async insertSystemMail(): Promise<never> { throw new Error('not used'); }
  async bulkInsertSystemMail(): Promise<never> { throw new Error('not used'); }
}

describe.skipIf(!mongo)('meta GET /lobby/badges e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  const fakeNow = new Date('2026-01-01T12:00:00Z').getTime();

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  async function login(): Promise<void> {
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'dev-lobby-badges-1' } }));
    token = r.data.token;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // create save record
  }

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
  });

  it('socialsvc not configured: social degrades to zeros, achievements/retention/events fields are not stripped', async () => {
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', now: () => fakeNow });
    await login();

    const r = body(await app.inject({ method: 'GET', url: '/lobby/badges', headers: auth() }));
    expect(r.ok).toBe(true);

    expect(r.data.social).toEqual({ friendRequests: 0, chat: 0, mail: 0, total: 0 });

    // achievements.defs must be the real (non-empty) definition table, not stripped to {}/[].
    expect(Array.isArray(r.data.achievements.defs)).toBe(true);
    expect(r.data.achievements.defs.length).toBeGreaterThan(0);
    for (const def of r.data.achievements.defs) {
      expect(typeof def.id).toBe('string');
      expect(Array.isArray(def.tiers)).toBe(true);
    }
    expect(typeof r.data.achievements.stats).toBe('object');
    expect(typeof r.data.achievements.achievements).toBe('object');

    expect(r.data.retentionClaimable).toHaveProperty('checkin');
    expect(r.data.retentionClaimable).toHaveProperty('daily');
    expect(r.data.retentionClaimable).toHaveProperty('weekly');
    expect(typeof r.data.retentionClaimable.checkin).toBe('boolean');
    expect(typeof r.data.retentionClaimable.daily).toBe('boolean');
    expect(typeof r.data.retentionClaimable.weekly).toBe('boolean');
    expect(r.data.retentionClaimable.weekly).toBe(false); // nothing accrued yet

    expect(r.data.eventsAvailable).toBe(false); // no active events seeded
  });

  // 2026-08-05 fix: getLobbyBadges used to hand-roll checkin/daily only (omitting weekly entirely) —
  // a player who'd earned a weekly-chest tier but already claimed today's checkin/daily saw no red
  // dot at all on the lobby's "每日" entry, even though hasRetentionClaimable (retention.ts, used by
  // the client mirror) already accounted for weekly tiers. Guards the wiring end-to-end: an accrued,
  // unclaimed weekly tier must surface as retentionClaimable.weekly === true here.
  it('a reached-but-unclaimed weekly chest tier surfaces as retentionClaimable.weekly = true (2026-08-05 fix)', async () => {
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', now: () => fakeNow });
    await login();

    const before = body(await app.inject({ method: 'GET', url: '/lobby/badges', headers: auth() }));
    expect(before.data.retentionClaimable.weekly).toBe(false);

    // Seed retention.weekly directly (accrueRetentionTask is only reachable from inside metaserver's
    // own settlement points, no HTTP endpoint for it — same technique as retention.e2e.test.ts's
    // seedWeeklyPoints), past the first tier's threshold (9) and not yet claimed.
    const doc = await m.collections.saves.findOne({});
    await m.collections.saves.updateOne(
      { _id: doc!._id },
      { $set: { 'save.retention.weekly': { weekKey: makeWeekKey(fakeNow), points: 9, claimedTiers: [] }, rev: doc!.rev + 1 } },
    );

    const after = body(await app.inject({ method: 'GET', url: '/lobby/badges', headers: auth() }));
    expect(after.data.retentionClaimable.weekly).toBe(true);
    // checkin/daily are independently still whatever they were — this fix must not affect them.
    expect(after.data.retentionClaimable.checkin).toBe(before.data.retentionClaimable.checkin);
    expect(after.data.retentionClaimable.daily).toBe(before.data.retentionClaimable.daily);
  });

  it('socialsvc configured: social badges are proxied through, not stripped', async () => {
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', now: () => fakeNow, socialsvc: new FakeSocialsvc() });
    await login();

    const r = body(await app.inject({ method: 'GET', url: '/lobby/badges', headers: auth() }));
    expect(r.ok).toBe(true);
    expect(r.data.social).toEqual({ friendRequests: 1, chat: 2, mail: 3, total: 6 });
  });

  it('socialsvc configured but erroring (non-200): degrades to zeros instead of failing the whole response', async () => {
    class ErroringSocialsvc extends FakeSocialsvc {
      override async proxy() { return { status: 503, data: { ok: false, error: { code: 'UNAVAILABLE', message: 'down' } } }; }
    }
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', now: () => fakeNow, socialsvc: new ErroringSocialsvc() });
    await login();

    const r = body(await app.inject({ method: 'GET', url: '/lobby/badges', headers: auth() }));
    expect(r.ok).toBe(true);
    expect(r.data.social).toEqual({ friendRequests: 0, chat: 0, mail: 0, total: 0 });
  });
});
