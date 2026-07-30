// Content-moderation penalty e2e (CONTENT_MODERATION_DESIGN.md CM6/CM7): the sole enforcement-execution
// path (applyPenalty) covering the §4.2 threshold ladder, "never downgrade" escalation rule, and the
// internal HTTP endpoint + rejectIfBanned honoring a temp ban (bannedUntil).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import { applyPenalty, actionForScore } from '../dist/moderation.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_moderation_penalty_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const KEY = 'k';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[moderation-penalty.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('content-moderation penalty e2e', () => {
  const m = mongo!;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
  });

  afterAll(async () => { await m.close(); });

  describe('actionForScore (§4.2 threshold table)', () => {
    it('maps score ranges to the confirmed action ladder', () => {
      expect(actionForScore(100)).toBe('none');
      expect(actionForScore(81)).toBe('none');
      expect(actionForScore(80)).toBe('warn');
      expect(actionForScore(61)).toBe('warn');
      expect(actionForScore(60)).toBe('mute');
      expect(actionForScore(41)).toBe('mute');
      expect(actionForScore(40)).toBe('tempban');
      expect(actionForScore(21)).toBe('tempban');
      expect(actionForScore(20)).toBe('ban');
      expect(actionForScore(0)).toBe('ban');
    });
  });

  describe('applyPenalty', () => {
    it('a fresh account starts at 100 and a single -20 penalty lands in the warn tier (80)', async () => {
      await m.collections.accounts.insertOne({ _id: 'acct1', createdAt: 0 } as never);
      const result = await applyPenalty(m.collections, 'acct1', -20, 1000);
      expect(result).toMatchObject({ reputationScore: 80, action: 'warn' });
      expect(result?.mutedUntil).toBeUndefined();
      expect(result?.bannedUntil).toBeUndefined();
      expect(result?.banned).toBeUndefined();

      const doc = await m.collections.accounts.findOne({ _id: 'acct1' });
      expect(doc?.flags?.reputationScore).toBe(80);
      expect(doc?.flags?.reputationDecayAt).toBe(1000 + 30 * DAY);
    });

    it('two -20 penalties (100→80→60) triggers a 24h mute on the second', async () => {
      await m.collections.accounts.insertOne({ _id: 'acct2', createdAt: 0 } as never);
      await applyPenalty(m.collections, 'acct2', -20, 1000);
      const r2 = await applyPenalty(m.collections, 'acct2', -20, 2000);
      expect(r2).toMatchObject({ reputationScore: 60, action: 'mute' });
      expect(r2?.mutedUntil).toBe(2000 + 24 * HOUR);

      const doc = await m.collections.accounts.findOne({ _id: 'acct2' });
      expect(doc?.flags?.mutedUntil).toBe(2000 + 24 * HOUR);
    });

    it('four -20 penalties (100→...→20) triggers a permanent ban, not just a temp ban', async () => {
      await m.collections.accounts.insertOne({ _id: 'acct3', createdAt: 0 } as never);
      let last;
      for (let i = 0; i < 4; i++) last = await applyPenalty(m.collections, 'acct3', -20, 1000 + i);
      expect(last).toMatchObject({ reputationScore: 20, action: 'ban', banned: true });

      const doc = await m.collections.accounts.findOne({ _id: 'acct3' });
      expect(doc?.flags?.banned).toBe(true);
    });

    it('reputationScore is clamped at 0 (cannot go negative)', async () => {
      await m.collections.accounts.insertOne({ _id: 'acct4', createdAt: 0, flags: { reputationScore: 5 } } as never);
      const result = await applyPenalty(m.collections, 'acct4', -20, 1000);
      expect(result?.reputationScore).toBe(0);
    });

    it('never downgrades an existing harsher mutedUntil/bannedUntil (a later milder-tier penalty keeps the longer expiry)', async () => {
      // Start already deep in mute territory with a mutedUntil far beyond what a fresh 24h computation
      // would produce (as if from a prior harsher tick, or an admin-extended mute).
      const farFuture = 10_000_000_000; // >> 2000 + 24h
      await m.collections.accounts.insertOne({
        _id: 'acct5', createdAt: 0,
        flags: { reputationScore: 55, mutedUntil: farFuture },
      } as never);
      // A tiny delta that still lands in the 'mute' tier (55-1=54) would compute mutedUntil = now+24h,
      // which is far SHORTER than the existing farFuture — must keep the longer one.
      const result = await applyPenalty(m.collections, 'acct5', -1, 2000);
      expect(result?.action).toBe('mute');
      expect(result?.mutedUntil).toBe(farFuture); // kept, not shortened to 2000+24h
    });

    it('an already-permanently-banned account stays banned regardless of this call\'s own tier', async () => {
      await m.collections.accounts.insertOne({
        _id: 'acct6', createdAt: 0,
        flags: { reputationScore: 10, banned: true },
      } as never);
      // This delta alone would only compute 'tempban' (10+5=15 → still <=20 → actually 'ban' too; use a
      // milder delta to land in 'mute' territory to prove banned isn't cleared by a milder recomputation).
      const result = await applyPenalty(m.collections, 'acct6', 45, 2000); // 10+45=55 → 'mute' tier
      expect(result?.banned).toBe(true); // still banned — never cleared by a milder subsequent penalty
    });

    it('returns null for a non-existent account', async () => {
      const result = await applyPenalty(m.collections, 'ghost', -20, 1000);
      expect(result).toBeNull();
    });
  });

  describe('POST /internal/accounts/:id/penalty + rejectIfBanned honoring bannedUntil', () => {
    let app: FastifyInstance;
    beforeEach(async () => {
      if (app) await app.close();
      app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
    });
    afterAll(async () => { if (app) await app.close(); });

    it('applies a penalty via the internal endpoint and reports the resulting action', async () => {
      await m.collections.accounts.insertOne({ _id: 'ep1', createdAt: 0 } as never);
      const r = await app.inject({
        method: 'POST',
        url: '/internal/accounts/ep1/penalty',
        headers: { 'x-internal-key': KEY },
        payload: { delta: -60 }, // 100-60=40 → tempban
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.payload);
      expect(body).toMatchObject({ ok: true, reputationScore: 40, action: 'tempban' });
      expect(typeof body.bannedUntil).toBe('number');
    });

    it('rejects without a valid internal key', async () => {
      await m.collections.accounts.insertOne({ _id: 'ep2', createdAt: 0 } as never);
      const r = await app.inject({ method: 'POST', url: '/internal/accounts/ep2/penalty', payload: { delta: -20 } });
      expect(r.statusCode).toBe(401);
    });

    it('a temp-banned account is rejected at auth (rejectIfBanned honors bannedUntil, not just the permanent flag)', async () => {
      const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'temp-banned-dev' } });
      const { accountId, token } = JSON.parse(r.payload).data as { accountId: string; token: string };

      const penaltyRes = await app.inject({
        method: 'POST',
        url: `/internal/accounts/${accountId}/penalty`,
        headers: { 'x-internal-key': KEY },
        payload: { delta: -60 }, // → tempban, bannedUntil far in the future
      });
      expect(JSON.parse(penaltyRes.payload).action).toBe('tempban');

      // Re-authenticating with the same device is now rejected (temp ban, cache invalidated by the penalty call).
      const secondAuth = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'temp-banned-dev' } });
      expect(secondAuth.statusCode).toBe(403);
      void token;
    });
  });
});
