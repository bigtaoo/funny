// End-to-end test for out-of-game sharing of state-stream replays (REPLAY_SHARE_DESIGN §3):
//   POST /replay/share (authenticated blob upload → shareCode) → public GET /r/{shareCode}
//   (anonymous retrieval + viewCount++).
//   Coverage: round-trip, anonymous retrieval, missing-code 404, oversized blob 400.
//   Requires `cd server && docker compose up -d` and `tsc -b` first (imports dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_state_share_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const KEY = 'k';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[state-replay-share.e2e] Mongo unreachable (${URI}) — skipping.`);

// blob is an opaque gzip+base64 string produced by the client (the server does not decompress or
// interpret it — only stores/retrieves it with a size gate and rate limiting).
// Tests only require any non-empty string to round-trip unchanged.
const sampleBlob = 'H4sIAAAAAAAA_compressed-state-replay-blob-base64==';

describe.skipIf(!mongo)('state replay share e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    // authRateLimit=0 disables auth rate limiting (test default).
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
    const ra = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'sr-aaaa-1' } }));
    token = ra.data.token;
  });

  afterAll(async () => { if (app) await app.close(); });

  it('mint share code → anonymous retrieval blob matches + viewCount++', async () => {
    const post = await app.inject({
      method: 'POST', url: '/replay/share',
      headers: { authorization: `Bearer ${token}` },
      payload: { blob: sampleBlob },
    });
    expect(post.statusCode).toBe(200);
    const shareCode = body(post).data.shareCode as string;
    expect(shareCode).toBeTruthy();

    // Public retrieval (no token).
    const get1 = await app.inject({ method: 'GET', url: `/r/${shareCode}` });
    expect(get1.statusCode).toBe(200);
    expect(body(get1).data.blob).toEqual(sampleBlob);

    // Fetch once more → viewCount increments (fire-and-forget $inc, not awaited by the handler; give it
    // a moment to land, same idiom as analyticsvc's fire-and-forget-write tests).
    await app.inject({ method: 'GET', url: `/r/${shareCode}` });
    await new Promise((r) => setTimeout(r, 200));
    const doc = await m.collections.stateReplayShares.findOne({ _id: shareCode });
    expect(doc!.createdBy).toBeTruthy();
    expect(doc!.viewCount).toBe(2);
  });

  it('unauthenticated share upload → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/replay/share', payload: { blob: sampleBlob } });
    expect(res.statusCode).toBe(401);
  });

  it('non-existent shareCode → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/r/nope-nope-nope' });
    expect(res.statusCode).toBe(404);
  });

  it('oversized blob → graceful 400 (not Fastify 413)', async () => {
    // > 2MB compressed string (still < 4MB Fastify bodyLimit): should hit the application-layer
    // graceful 400 "replay too large" rather than being preempted by Fastify's 413.
    const big = 'A'.repeat(2 * 1024 * 1024 + 16);
    const res = await app.inject({
      method: 'POST', url: '/replay/share',
      headers: { authorization: `Bearer ${token}` },
      payload: { blob: big },
    });
    expect(res.statusCode).toBe(400);
  });

  it('missing blob → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/replay/share',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('per-account share-minting rate limit (STATE_REPLAY_SHARE_PER_HOUR=20): the 21st share in an hour is rejected (2026-07-27 — previously untested; the underlying limiter used to be a hand-rolled Map with a memory leak, now consolidated into createRateLimiter/base.ts)', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'POST', url: '/replay/share',
        headers: { authorization: `Bearer ${token}` },
        payload: { blob: `${sampleBlob}-${i}` },
      });
      expect(res.statusCode).toBe(200);
    }
    const over = await app.inject({
      method: 'POST', url: '/replay/share',
      headers: { authorization: `Bearer ${token}` },
      payload: { blob: `${sampleBlob}-over` },
    });
    expect(over.statusCode).toBe(429);
  });
});
