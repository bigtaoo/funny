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
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
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

  it('rejects an unauthenticated submission (no bearer token)', async () => {
    const r = await app.inject({ method: 'POST', url: '/feedback', payload: { text: 'no token here' } });
    expect(r.statusCode).toBe(401);
    expect(await m.collections.feedback.countDocuments({})).toBe(0);
  });

  it('stamps clientPlatform from the X-NW-Platform header (commercial spend-channel convention, service/base.ts)', async () => {
    const { accountId, token } = await newDevice('dev-feedback-platform');
    const r = await app.inject({
      method: 'POST', url: '/feedback',
      headers: { authorization: `Bearer ${token}`, 'x-nw-platform': 'wechat' },
      payload: { text: 'played on wechat' },
    });
    expect(r.statusCode).toBe(200);
    const doc = await m.collections.feedback.findOne({ accountId });
    expect(doc?.clientPlatform).toBe('wechat');
  });

  it('leaves clientPlatform unset when the header is absent (BSON stores the omitted optional field as null)', async () => {
    const { accountId, token } = await newDevice('dev-feedback-no-platform');
    await app.inject({
      method: 'POST', url: '/feedback',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'no platform header' },
    });
    const doc = await m.collections.feedback.findOne({ accountId });
    expect(doc?.clientPlatform).toBeFalsy();
  });

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

  // ── Triage trail (feedback.action, POST /internal/feedback/:id/review) ──────────────
  // Not a verdict/status machine (there is nothing to dismiss or uphold, unlike appeals) — just enough
  // state for a growing backlog to stay trackable: unread ⟺ !readAt.
  describe('POST /internal/feedback/:id/review', () => {
    async function submit(deviceId: string, text: string): Promise<string> {
      const { accountId, token } = await newDevice(deviceId);
      await app.inject({
        method: 'POST', url: '/feedback',
        headers: { authorization: `Bearer ${token}` },
        payload: { text },
      });
      return (await m.collections.feedback.findOne({ accountId }))!._id;
    }
    const review = (id: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/internal/feedback/${id}/review`, headers: { 'x-internal-key': KEY }, payload });

    it('requires the internal key', async () => {
      const id = await submit('dev-review-authed', 'needs a key');
      const r = await app.inject({ method: 'POST', url: `/internal/feedback/${id}/review`, payload: { readBy: 'admin-1' } });
      expect(r.statusCode).toBe(401);
      expect((await m.collections.feedback.findOne({ _id: id }))?.readAt).toBeFalsy();
    });

    it('rejects a call without readBy (the row would be marked read by nobody)', async () => {
      const id = await submit('dev-review-no-actor', 'who read this?');
      expect((await review(id, { note: 'orphan note' })).statusCode).toBe(400);
      expect((await m.collections.feedback.findOne({ _id: id }))?.note).toBeFalsy();
    });

    it('404s on an unknown id', async () => {
      expect((await review('no-such-feedback', { readBy: 'admin-1' })).statusCode).toBe(404);
    });

    it('marks a row read: stamps readAt/readBy, leaving note unset', async () => {
      const id = await submit('dev-review-mark', 'a fine game');
      expect((await review(id, { readBy: 'admin-1' })).statusCode).toBe(200);
      const doc = await m.collections.feedback.findOne({ _id: id });
      expect(doc?.readAt).toBeGreaterThan(0);
      expect(doc?.readBy).toBe('admin-1');
      expect(doc?.note).toBeFalsy();
    });

    it('writing a note also marks the row read (one action, not two)', async () => {
      const id = await submit('dev-review-note', 'the tutorial drags');
      await review(id, { readBy: 'admin-1', note: 'known, tracked in the onboarding backlog' });
      const doc = await m.collections.feedback.findOne({ _id: id });
      expect(doc?.note).toBe('known, tracked in the onboarding backlog');
      expect(doc?.readAt).toBeGreaterThan(0);
    });

    it('readAt is first-review-only (never overwritten), while readBy/note are last-write-wins', async () => {
      const id = await submit('dev-review-twice', 'balance feels off');
      await review(id, { readBy: 'admin-1' });
      const first = (await m.collections.feedback.findOne({ _id: id }))!.readAt;
      await review(id, { readBy: 'admin-2', note: 'forwarded to design' });
      const doc = await m.collections.feedback.findOne({ _id: id });
      expect(doc?.readAt).toBe(first); // "when did we first look at this", not "last touched"
      expect(doc?.readBy).toBe('admin-2');
      expect(doc?.note).toBe('forwarded to design');
    });

    it('omitting note leaves an existing note intact; an empty note explicitly clears it', async () => {
      const id = await submit('dev-review-clear', 'crashes on level 3');
      await review(id, { readBy: 'admin-1', note: 'repro pending' });
      await review(id, { readBy: 'admin-1' }); // read-mark only — must not wipe the note
      expect((await m.collections.feedback.findOne({ _id: id }))?.note).toBe('repro pending');
      await review(id, { readBy: 'admin-1', note: '   ' }); // whitespace-only == clear
      expect((await m.collections.feedback.findOne({ _id: id }))?.note).toBeFalsy();
    });

    it('truncates an over-long note to FEEDBACK_NOTE_MAX', async () => {
      const id = await submit('dev-review-long-note', 'wall of text incoming');
      await review(id, { readBy: 'admin-1', note: 'x'.repeat(2000) });
      expect((await m.collections.feedback.findOne({ _id: id }))?.note?.length).toBe(500);
    });
  });
});
