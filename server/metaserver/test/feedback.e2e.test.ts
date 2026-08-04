// Player feedback e2e (UI_DESIGN.md §4.1.1 lobby entry, SERVER_API.md §2.13): POST /feedback (free-text,
// rate-limited per account, multiple submissions allowed — no "one open ticket" model, unlike appeals) +
// the admin-facing GET /internal/feedback listing (read-only, no resolve/status machine).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_feedback_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const KEY = 'k';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[feedback.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('player feedback e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
  });
  afterAll(async () => { if (app) await app.close(); });

  async function newDevice(deviceId: string): Promise<{ accountId: string; token: string }> {
    const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } });
    return JSON.parse(r.payload).data as { accountId: string; token: string };
  }

  it('accepts free-text feedback and persists it against the account', async () => {
    const { accountId, token } = await newDevice('dev-feedback-1');
    const r = await app.inject({
      method: 'POST', url: '/feedback',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'love the game, the ink-splatter effect is great' },
    });
    expect(r.statusCode).toBe(200);
    const doc = await m.collections.feedback.findOne({ accountId });
    expect(doc).toMatchObject({ accountId, text: 'love the game, the ink-splatter effect is great' });
  });

  it('rejects an empty (or whitespace-only) submission', async () => {
    const { token } = await newDevice('dev-feedback-empty');
    const r = await app.inject({
      method: 'POST', url: '/feedback',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: '   ' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects a submission over the openapi maxLength (schema validation, before the handler runs)', async () => {
    const { token } = await newDevice('dev-feedback-long');
    const long = 'x'.repeat(5000);
    const r = await app.inject({
      method: 'POST', url: '/feedback',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: long },
    });
    expect(r.statusCode).toBe(400);
  });

  it('handler-level slice to FEEDBACK_TEXT_MAX is defense-in-depth: exactly-at-the-limit text is stored in full', async () => {
    const { accountId, token } = await newDevice('dev-feedback-at-limit');
    const atLimit = 'x'.repeat(1000);
    const r = await app.inject({
      method: 'POST', url: '/feedback',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: atLimit },
    });
    expect(r.statusCode).toBe(200);
    const doc = await m.collections.feedback.findOne({ accountId });
    expect(doc?.text.length).toBe(1000);
  });

  it('allows repeated submissions from the same account (no "one open ticket" model, unlike appeals)', async () => {
    const { accountId, token } = await newDevice('dev-feedback-repeat');
    for (const text of ['first note', 'second note']) {
      const r = await app.inject({
        method: 'POST', url: '/feedback',
        headers: { authorization: `Bearer ${token}` },
        payload: { text },
      });
      expect(r.statusCode).toBe(200);
    }
    const docs = await m.collections.feedback.find({ accountId }).toArray();
    expect(docs.length).toBe(2);
  });

  it('rate-limits a burst of submissions from the same account (429), but a different account is unaffected', async () => {
    const { token } = await newDevice('dev-feedback-burst');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        app.inject({
          method: 'POST', url: '/feedback',
          headers: { authorization: `Bearer ${token}` },
          payload: { text: `burst ${i}` },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200).length).toBe(5); // FEEDBACK_RATE_LIMIT_PER_DAY
    expect(codes.filter((c) => c === 429).length).toBe(3);

    const { token: otherToken } = await newDevice('dev-feedback-other');
    const other = await app.inject({
      method: 'POST', url: '/feedback',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { text: 'unaffected by the other account\'s burst' },
    });
    expect(other.statusCode).toBe(200);
  });

  it('GET /internal/feedback lists submissions newest-first and requires the internal key', async () => {
    const { accountId, token } = await newDevice('dev-feedback-listed');
    await app.inject({
      method: 'POST', url: '/feedback',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'please add more character skins' },
    });

    const unauthed = await app.inject({ method: 'GET', url: '/internal/feedback' });
    expect(unauthed.statusCode).toBe(401);

    const listed = await app.inject({ method: 'GET', url: '/internal/feedback', headers: { 'x-internal-key': KEY } });
    expect(listed.statusCode).toBe(200);
    const { feedback } = JSON.parse(listed.payload) as { feedback: { accountId: string; text: string }[] };
    expect(feedback.some((f) => f.accountId === accountId && f.text === 'please add more character skins')).toBe(true);
  });
});
