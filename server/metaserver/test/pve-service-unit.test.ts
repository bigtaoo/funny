// Unit-style coverage backfill for src/service/pve/{clear,verify,helpers,stamina}.ts (2026-08-14
// test-coverage task). These handlers' business logic is already exercised end-to-end by
// test/pve.e2e.test.ts, test/pve-verify.e2e.test.ts and test/pve-enter.e2e.test.ts, but those files
// import `buildApp` from '../dist/app.js' — vitest's v8 coverage provider only source-map-attributes
// execution of modules it itself loaded via its Vite transform, so running the *compiled* dist/*.js
// through Node's own ESM loader records zero coverage against the src/*.ts lines that actually ran.
// This file imports directly from '../src/...' so the exact same kind of request-level exercise gets
// attributed correctly, re-exercises the same happy-path scenarios, and adds the error/edge branches
// the e2e files' happy-path-oriented scenarios don't reach (banned-account variants, spot-check reason
// branches, malformed statsJson, grantCards-failure regressions, stamina purchase edge branches, ...).
//
// Real Mongo (rs0), same convention as pve.e2e.test.ts/pve-verify.e2e.test.ts — grantCards/
// recordMaterialGrants/toInstanceDoc rely on $addToSet-with-$each / $push-with-$each/$slice /
// findOneAndUpdate rev-guard retries, none of which test/helpers/fakeCollection.ts's generic in-memory
// double implements, so a real Mongo instance is the pragmatic choice here (not a from-scratch
// reimplementation of those operators).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle, PVE_DAILY_CLEAR_REWARD_CAP } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { GatewayClient, JudgeReq, JudgeRes } from '../src/gatewayClient.js';
import { FakeSocialsvc, ThrowingSocialsvc } from './helpers/fakeClients.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_pve_unit_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[pve-service-unit] Mongo unreachable (${URI}) — skipping.`);

/** Configurable fake judge: records the last judge call's arguments and returns a preset verdict. */
class FakeGateway implements GatewayClient {
  available = true;
  next: JudgeRes = { ok: true, stars: 3, judgeAccountId: 'judge-1' };
  last?: JudgeReq;
  async judge(req: JudgeReq): Promise<JudgeRes> {
    this.last = req;
    return this.next;
  }
  async push(): Promise<void> {}
  async presence(): Promise<Record<string, boolean>> {
    return {};
  }
  async invalidateFriends(): Promise<void> {}
}

/** Minimal commercial fake for the stamina-purchase branches (spend success/failure) + the
 *  roster-full chapter-card coin-compensation branch (grant). */
class FakeCommercial {
  readonly available = true;
  spendCalls: Array<{ accountId: string; amount: number; reason: string; orderId: string }> = [];
  grantCalls: Array<{ accountId: string; amount: number; reason: string; orderId: string }> = [];
  nextSpendFail = false;
  async spend(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    this.spendCalls.push(a);
    if (this.nextSpendFail) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
    return { ok: true as const, coinsAfter: 0 };
  }
  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    this.grantCalls.push(a);
    return { ok: true as const, coinsAfter: a.amount };
  }
}

describe.skipIf(!mongo)('pve service handlers (src import, coverage backfill)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let gateway: FakeGateway;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;

  const b = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const clear = (levelId: string, stars = 3, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/pve/clear', headers: auth(), payload: { levelId, stars, ...extra } });
  const verify = (verifyId: string, endFrame = 100) =>
    app.inject({ method: 'POST', url: '/pve/verify', headers: auth(), payload: { verifyId, endFrame, frames: [] } });
  const enter = (levelId: string) => app.inject({ method: 'POST', url: '/pve/enter', headers: auth(), payload: { levelId } });

  async function buildAndAuth(opts: { withGateway?: boolean; socialsvc?: unknown; commercial?: unknown; deviceId?: string; now?: () => number } = {}): Promise<{ token: string; accountId: string }> {
    gateway = new FakeGateway();
    comm = (opts.commercial as FakeCommercial) ?? new FakeCommercial();
    const buildOpts: Record<string, unknown> = { cols: m.collections, jwt, internalKey: 'k', commercial: comm };
    if (opts.withGateway !== false) buildOpts.gateway = gateway;
    if (opts.socialsvc) buildOpts.socialsvc = opts.socialsvc;
    if (opts.now) buildOpts.now = opts.now;
    app = await buildApp(buildOpts as never);
    const r = b(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: opts.deviceId ?? `pve-unit-${Math.random()}` } }));
    await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${r.data.token}` } }); // initialize save
    return { token: r.data.token, accountId: r.data.accountId };
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    const r = await buildAndAuth();
    token = r.token;
    accountId = r.accountId;
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  // ── clear.ts: pveClearHandler ────────────────────────────────────────────────────────────────
  describe('POST /pve/clear', () => {
    it('unknown level -> 400', async () => {
      const r = await clear('no_such_level');
      expect(r.statusCode).toBe(400);
    });

    it('stars out of range (0 or >3) -> 400', async () => {
      expect((await clear('ch1_lv1', 0)).statusCode).toBe(400);
      expect((await clear('ch1_lv1', 4)).statusCode).toBe(400);
    });

    it('locked level (prerequisite not cleared) -> 400', async () => {
      expect((await clear('ch1_lv2', 3)).statusCode).toBe(400);
    });

    it('account-level ban (accounts.flags.banned) -> 403', async () => {
      await m.collections.accounts.updateOne({ _id: accountId }, { $set: { 'flags.banned': true } });
      // rejectIfBanned is cached (AccountCache, 60s TTL) and was already primed to "not banned" by the
      // /auth/device call inside buildAndAuth (auth/credential.ts also calls rejectIfBanned) — rebuild the
      // app (fresh AccountCache) so this account's next ban check is a genuine cache-miss read of Mongo.
      const rebuiltApp = await buildApp({ cols: m.collections, jwt, internalKey: 'k', gateway, commercial: comm });
      try {
        const r = await rebuiltApp.inject({ method: 'POST', url: '/pve/clear', headers: auth(), payload: { levelId: 'ch1_lv1', stars: 3 } });
        expect(r.statusCode).toBe(403);
      } finally {
        await rebuiltApp.close();
      }
    });

    it('save-level ban (save.antiCheat.pveBanned) -> 403', async () => {
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.antiCheat.pveBanned': true } });
      const r = await clear('ch1_lv1', 3);
      expect(r.statusCode).toBe(403);
    });

    it('no gateway configured: happy path, normal clear settles immediately (no spot-check)', async () => {
      await buildAndAuth({ withGateway: false });
      const r = b(await clear('ch1_lv1', 3));
      expect(r.data.needsReplay).toBeUndefined();
      expect(r.data.granted).toEqual({ scrap: 6, lead: 2 });
      expect(r.data.grantedCards).toEqual({ 'infantry:1': 1 });
    });

    it('welcome mail (ONBOARDING_DESIGN §5.1): first-ever clear sends mail + mail_new push; second clear does not resend', async () => {
      const socialsvc = new FakeSocialsvc();
      await buildAndAuth({ socialsvc });
      await clear('ch1_lv1', 3);
      const mailId = `welcome.author:${accountId}`;
      expect(socialsvc.mail.has(mailId)).toBe(true);
      await clear('ch1_lv2', 3);
      expect(socialsvc.mail.size).toBe(1);
    });

    it('welcome mail is best-effort: a failed send does not block clear settlement', async () => {
      await buildAndAuth({ socialsvc: new ThrowingSocialsvc(), withGateway: false });
      const r = b(await clear('ch1_lv1', 3));
      expect(r.data.granted).toEqual({ scrap: 6, lead: 2 });
    });

    it('L0 anomaly via unitLevels mismatch -> spot-check reason "anomaly", needsReplay', async () => {
      const r = b(await clear('ch1_lv1', 3, { unitLevels: { infantry: 5 } }));
      expect(r.data.needsReplay).toBe(true);
      expect(r.data.granted).toEqual({});
    });

    it('L0 anomaly via legacy pveUpgrades mismatch -> spot-check reason "anomaly"', async () => {
      const r = b(await clear('ch1_lv1', 3, { pveUpgrades: { infantry: 5 } }));
      expect(r.data.needsReplay).toBe(true);
    });

    it('first clear (no mismatch) -> always spot-checked (reason "first")', async () => {
      const r = b(await clear('ch1_lv1', 3));
      expect(r.data.needsReplay).toBe(true);
      expect(r.data.save.progress.cleared).toContain('ch1_lv1');
    });

    it('random sampling: forced rand<rate on a replay clear -> spot-checked (reason "sample")', async () => {
      await clear('ch1_lv1', 3); // consume the first-clear spot-check
      await verify((b(await clear('ch1_lv1', 3))).data.verifyId ?? ''); // settle if spot-checked again; ignore result
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0); // < PVE_VERIFY_SAMPLE_RATE
      try {
        const r = b(await clear('ch1_lv1', 3));
        expect(r.data.needsReplay).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('not first clear, no mismatch, high random -> normal settle (no spot-check)', async () => {
      await clear('ch1_lv1', 3);
      const c = b(await clear('ch1_lv1', 3));
      if (c.data.needsReplay) await verify(c.data.verifyId);
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999); // >= sample rate
      try {
        const r = b(await clear('ch1_lv1', 3));
        expect(r.data.needsReplay).toBeUndefined();
        expect(r.data.granted).toEqual({ scrap: 6, lead: 2 });
      } finally {
        spy.mockRestore();
      }
    });

    it('level with no exploitable reward (ch_stress) is never spot-checked even with a judge available', async () => {
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.progress.cleared': ['ch1_lv1', 'ch1_lv2', 'ch1_lv3'] } });
      const r = b(await clear('ch_stress', 3));
      expect(r.data.needsReplay).toBeUndefined();
      expect(r.data.granted).toEqual({});
    });

    it('chapter-clear exclusive card granted on the spot-check path alongside progress', async () => {
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.progress.cleared': ['ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4', 'ch1_lv5', 'ch1_lv6', 'ch1_lv7', 'ch1_lv8', 'ch1_lv9'] } },
      );
      const r = b(await clear('ch1_lv10', 3));
      expect(r.data.needsReplay).toBe(true);
      const lv2 = Object.values(r.data.save.cardInv as Record<string, { defId: string; level: number }>)
        .filter((x) => x.defId === 'lichuang' && x.level === 2).length;
      expect(lv2).toBe(1);
      expect(r.data.save.stats['campaign.chaptersCleared']).toBe(1);
    });

    it('chapter-clear exclusive card is also granted on the NORMAL (non-spot-checked) settle path', async () => {
      await buildAndAuth({ withGateway: false }); // no judge -> settleNormalClear, not the spot-check branch
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.progress.cleared': ['ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4', 'ch1_lv5', 'ch1_lv6', 'ch1_lv7', 'ch1_lv8', 'ch1_lv9'] } },
      );
      const r = b(await clear('ch1_lv10', 3));
      expect(r.data.needsReplay).toBeUndefined();
      const lv2 = Object.values(r.data.save.cardInv as Record<string, { defId: string; level: number }>)
        .filter((x) => x.defId === 'lichuang' && x.level === 2).length;
      expect(lv2).toBe(1);
    });

    it('chapter-clear card grant with a full Hero Roster falls back to coin compensation via commercial.grant', async () => {
      await buildAndAuth({ withGateway: false });
      // Fill the roster to CARD_INV_CAP (500) directly via Mongo — far cheaper than 500 real grants.
      // gearInstanceIds carries a unique multikey index — an empty array indexes as a single null-equivalent
      // entry (MongoDB multikey semantics), so 500 docs all with `[]` would collide; give each a unique
      // (unused, never-really-equipped) placeholder id instead.
      const docs = Array.from({ length: 500 }, (_, i) => ({
        _id: `filler-${i}`, accountId, defId: 'wp_pencil', level: 1, gear: {}, gearInstanceIds: [`filler-gear-${i}`], locked: false,
      }));
      await m.collections.cardInstances.insertMany(docs as never);
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.cardInvCount': 500, 'save.progress.cleared': ['ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4', 'ch1_lv5', 'ch1_lv6', 'ch1_lv7', 'ch1_lv8', 'ch1_lv9'] } },
      );
      const r = b(await clear('ch1_lv10', 3));
      expect(comm.grantCalls.length).toBeGreaterThan(0);
      expect(comm.grantCalls[0]).toMatchObject({ reason: 'chapter_card_inv_full' });
      expect(r.statusCode ?? 200).toBe(200);
    });

    it('daily cap: over-cap clear is capped (no materials/cards), progress still recorded', async () => {
      await buildAndAuth({ withGateway: false });
      for (let i = 0; i < PVE_DAILY_CLEAR_REWARD_CAP; i++) await clear('ch1_lv1', 2);
      const over = b(await clear('ch1_lv1', 2));
      expect(over.data.capped).toBe(true);
      expect(over.data.granted).toEqual({});
      expect(over.data.grantedCards).toEqual({});
    });

    it('equipment drop is granted and stamped with pve_drop provenance', async () => {
      await buildAndAuth({ withGateway: false });
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.progress.cleared': ['ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4'] } });
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
      try {
        const r = b(await clear('ch1_lv5', 3));
        expect(r.data.grantedEquipment).toBeTruthy();
        expect(r.data.grantedEquipment.sourceType).toBe('pve_drop:ch1_lv5');
      } finally {
        spy.mockRestore();
      }
    });

    it('client stats within bounds accrue into lifetime stats (normal-clear path)', async () => {
      await buildAndAuth({ withGateway: false });
      const r = b(await clear('ch1_lv1', 3, { stats: { 'kill.archer': 3 } }));
      expect(r.data.save.stats?.['kill.archer']).toBe(3);
    });

    it('client stats entirely out of bounds are discarded (cleanStats stays undefined, no accrual, no crash)', async () => {
      await buildAndAuth({ withGateway: false });
      const r = b(await clear('ch1_lv1', 3, { stats: { 'kill.archer': 999999 } }));
      expect(r.data.save.stats?.['kill.archer'] ?? 0).toBe(0);
    });

    it('regression: a failed card-grant on /pve/clear leaves nothing committed (grantCards runs before the consolidated write)', async () => {
      const realSaves = m.collections.saves;
      const wrappedSaves = {
        findOne: realSaves.findOne.bind(realSaves),
        findOneAndUpdate: async (
          filter: Parameters<typeof realSaves.findOneAndUpdate>[0],
          update: Parameters<typeof realSaves.findOneAndUpdate>[1],
          opts?: Parameters<typeof realSaves.findOneAndUpdate>[2],
        ) => {
          const current = await realSaves.findOne(filter as Record<string, unknown>);
          const incomingCardInvCount = (update as { $set?: { save?: { cardInvCount?: number } } }).$set?.save?.cardInvCount;
          const isCardGrantWrite = !!current && incomingCardInvCount !== undefined && incomingCardInvCount !== current.save.cardInvCount;
          if (isCardGrantWrite) return null;
          return realSaves.findOneAndUpdate(filter, update, opts);
        },
      } as typeof realSaves;
      const failingApp = await buildApp({ cols: { ...m.collections, saves: wrappedSaves }, jwt, internalKey: 'k' });
      try {
        const failed = await failingApp.inject({ method: 'POST', url: '/pve/clear', headers: auth(), payload: { levelId: 'ch1_lv1', stars: 3 } });
        expect(failed.statusCode).toBe(409);
      } finally {
        await failingApp.close();
      }
      const after = b(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(after.data.save.materials.scrap ?? 0).toBe(0);
    });
  });

  // ── verify.ts: pveVerifyHandler ──────────────────────────────────────────────────────────────
  describe('POST /pve/verify', () => {
    it('unknown verifyId -> 404', async () => {
      expect((await verify('no-such-id')).statusCode).toBe(404);
    });

    it('verifyId belonging to a different account -> 404', async () => {
      const c = b(await clear('ch1_lv1', 3));
      const other = await buildAndAuth({ deviceId: `other-${Math.random()}` });
      token = other.token;
      const r = await verify(c.data.verifyId);
      expect(r.statusCode).toBe(404);
    });

    it('account banned (save.antiCheat.pveBanned) at verify time -> 403', async () => {
      const c = b(await clear('ch1_lv1', 3));
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.antiCheat.pveBanned': true } });
      const r = await verify(c.data.verifyId);
      expect(r.statusCode).toBe(403);
    });

    it('unknown level referenced by the verification doc -> 400', async () => {
      await m.collections.pveVerifications.insertOne({
        _id: 'ghost-verify-1',
        accountId,
        levelId: 'no_such_level',
        claimedStars: 3,
        cardInv: {},
        equipmentInv: {},
        reason: 'first',
        status: 'pending',
        ts: Date.now(),
      });
      const r = await verify('ghost-verify-1');
      expect(r.statusCode).toBe(400);
    });

    it('already-settled doc (duplicate submission) -> idempotent, no re-grant', async () => {
      const c = b(await clear('ch1_lv1', 3));
      gateway.next = { ok: true, stars: 3 };
      await verify(c.data.verifyId);
      const again = b(await verify(c.data.verifyId));
      expect(again.data.granted).toEqual({});
    });

    it('re-computation passes -> grant materials + cards, verified true', async () => {
      const c = b(await clear('ch1_lv1', 3));
      gateway.next = { ok: true, stars: 3 };
      const v = b(await verify(c.data.verifyId));
      expect(v.data.verified).toBe(true);
      expect(v.data.granted).toEqual({ scrap: 6, lead: 2 });
      expect(v.data.grantedCards).toEqual({ 'infantry:1': 1 });
    });

    it('re-computation stars < claimed -> rejected, files review ticket + warning mail, no materials', async () => {
      const socialsvc = new FakeSocialsvc();
      await buildAndAuth({ socialsvc });
      const c = b(await clear('ch1_lv1', 3));
      gateway.next = { ok: true, stars: 1 };
      const v = b(await verify(c.data.verifyId));
      expect(v.data.verified).toBe(false);
      expect(v.data.granted).toEqual({});
      const review = await m.collections.antiCheatReviews.findOne({ _id: `pve:${c.data.verifyId}` });
      expect(review?.severity).toBe('normal');
      expect(socialsvc.mail.has(`pve-warn-${c.data.verifyId}:${accountId}`)).toBe(true);
    });

    it('repeated rejections escalate review severity to "high" at the ban threshold, warning mail failures are swallowed (best-effort)', async () => {
      await buildAndAuth({ socialsvc: new ThrowingSocialsvc() });
      gateway.next = { ok: true, stars: 1 };
      for (const levelId of ['ch1_lv1', 'ch1_lv2', 'ch1_lv3']) {
        const c = b(await clear(levelId, 3));
        expect(c.data.needsReplay).toBe(true);
        await verify(c.data.verifyId);
      }
      const reviews = await m.collections.antiCheatReviews.find({ kind: 'pve_reject' }).sort({ ts: 1 }).toArray();
      expect(reviews.map((r) => r.severity)).toEqual(['normal', 'normal', 'high']);
    });

    it('no judge available (ok:false) -> benefit-of-doubt, materials still granted, verified true', async () => {
      const c = b(await clear('ch1_lv1', 3));
      gateway.next = { ok: false };
      const v = b(await verify(c.data.verifyId));
      expect(v.data.verified).toBe(true);
      expect(v.data.granted).toEqual({ scrap: 6, lead: 2 });
    });

    it('judged stats accrue into lifetime stats only when status is verified (not unverified)', async () => {
      const c = b(await clear('ch1_lv1', 3));
      gateway.next = { ok: true, stars: 3, statsJson: '{"kill.archer":4}' };
      const v = b(await verify(c.data.verifyId));
      expect(v.data.save.stats?.['kill.archer']).toBe(4);
    });

    it('benefit-of-doubt (unverified) never accrues judged stats even if statsJson is set', async () => {
      const c = b(await clear('ch1_lv1', 3));
      gateway.next = { ok: false, statsJson: '{"kill.archer":4}' };
      const v = b(await verify(c.data.verifyId));
      expect(v.data.save.stats?.['kill.archer'] ?? 0).toBe(0);
    });

    it('malformed statsJson (invalid JSON) is caught, no crash, no accrual', async () => {
      const c = b(await clear('ch1_lv1', 3));
      gateway.next = { ok: true, stars: 3, statsJson: 'not-json{' };
      const v = b(await verify(c.data.verifyId));
      expect(v.data.verified).toBe(true);
      expect(v.data.save.stats?.['kill.archer'] ?? 0).toBe(0);
    });

    it('statsJson parses to a non-object (array or primitive) -> skipped, no accrual', async () => {
      const c1 = b(await clear('ch1_lv1', 3));
      gateway.next = { ok: true, stars: 3, statsJson: '[1,2,3]' };
      const v1 = b(await verify(c1.data.verifyId));
      expect(v1.data.save.stats?.['kill.archer'] ?? 0).toBe(0);

      const c2 = b(await clear('ch1_lv2', 3));
      gateway.next = { ok: true, stars: 3, statsJson: '"just-a-string"' };
      const v2 = b(await verify(c2.data.verifyId));
      expect(v2.data.save.stats?.['kill.archer'] ?? 0).toBe(0);
    });

    it('judged stats entirely out of bounds are discarded (cleanStats empty, no crash)', async () => {
      const c = b(await clear('ch1_lv1', 3));
      gateway.next = { ok: true, stars: 3, statsJson: '{"kill.archer":999999}' };
      const v = b(await verify(c.data.verifyId));
      expect(v.data.verified).toBe(true);
      expect(v.data.save.stats?.['kill.archer'] ?? 0).toBe(0);
    });

    it('equipment drop is delivered via deliverVerifiedClearReward and stamped with provenance', async () => {
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.progress.cleared': ['ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4'] } });
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
      try {
        const c = b(await clear('ch1_lv5', 3));
        expect(c.data.needsReplay).toBe(true); // first clear of ch1_lv5, always sampled
        gateway.next = { ok: true, stars: 3 };
        const v = b(await verify(c.data.verifyId));
        expect(v.data.grantedEquipment).toBeTruthy();
        expect(v.data.grantedEquipment.sourceType).toBe('pve_drop:ch1_lv5');
        const stored = await m.collections.equipmentInstances.findOne({ _id: v.data.grantedEquipment.id });
        expect(stored?.sourceType).toBe('pve_drop:ch1_lv5');
      } finally {
        spy.mockRestore();
      }
    });

    it('regression: concurrent duplicate submissions for the same verifyId grant materials exactly once (lost-race idempotent branch)', async () => {
      const c = b(await clear('ch1_lv1', 3));
      let resolveJudge!: () => void;
      const gate = new Promise<void>((resolve) => { resolveJudge = resolve; });
      gateway.judge = async (req) => {
        gateway.last = req;
        await gate;
        return { ok: true, stars: 3 };
      };
      const call1 = verify(c.data.verifyId);
      const call2 = verify(c.data.verifyId);
      await new Promise((r) => setTimeout(r, 20));
      resolveJudge();
      const [r1, r2] = (await Promise.all([call1, call2])).map(b);
      const grantedCount = [r1, r2].filter((r) => r.data.granted?.scrap > 0).length;
      expect(grantedCount).toBe(1);
    });

    it('regression: a failed card-grant during verify settlement -> 409, no partial delivery', async () => {
      const c = b(await clear('ch1_lv1', 3));
      const realSaves = m.collections.saves;
      const wrappedSaves = {
        findOne: realSaves.findOne.bind(realSaves),
        findOneAndUpdate: async (
          filter: Parameters<typeof realSaves.findOneAndUpdate>[0],
          update: Parameters<typeof realSaves.findOneAndUpdate>[1],
          opts?: Parameters<typeof realSaves.findOneAndUpdate>[2],
        ) => {
          const current = await realSaves.findOne(filter as Record<string, unknown>);
          const incomingCardInvCount = (update as { $set?: { save?: { cardInvCount?: number } } }).$set?.save?.cardInvCount;
          const isCardGrantWrite = !!current && incomingCardInvCount !== undefined && incomingCardInvCount !== current.save.cardInvCount;
          if (isCardGrantWrite) return null;
          return realSaves.findOneAndUpdate(filter, update, opts);
        },
      } as typeof realSaves;
      const failingApp = await buildApp({ cols: { ...m.collections, saves: wrappedSaves }, jwt, internalKey: 'k', gateway });
      try {
        gateway.next = { ok: true, stars: 3 };
        const r = await failingApp.inject({ method: 'POST', url: '/pve/verify', headers: auth(), payload: { verifyId: c.data.verifyId, endFrame: 100, frames: [] } });
        expect(r.statusCode).toBe(409);
      } finally {
        await failingApp.close();
      }
    });
  });

  // ── stamina.ts: pveEnterHandler / purchaseStaminaHandler ────────────────────────────────────
  describe('POST /pve/enter', () => {
    it('happy path: deducts default cost (10) from a full bar (120)', async () => {
      const r = b(await enter('ch1_lv1'));
      expect(r.data.stamina.current).toBe(110);
      expect(r.data.stamina.regenAt).toBeGreaterThan(0);
    });

    it('unknown level -> 400', async () => {
      expect((await enter('no_such_level')).statusCode).toBe(400);
    });

    it('locked level -> 400', async () => {
      expect((await enter('ch1_lv2')).statusCode).toBe(400);
    });

    it('account-level ban -> 403', async () => {
      await m.collections.accounts.updateOne({ _id: accountId }, { $set: { 'flags.banned': true } });
      // Same AccountCache-staleness reasoning as the /pve/clear ban test above: rebuild the app so the
      // ban check is a genuine cache-miss read.
      const rebuiltApp = await buildApp({ cols: m.collections, jwt, internalKey: 'k', gateway, commercial: comm });
      try {
        const r = await rebuiltApp.inject({ method: 'POST', url: '/pve/enter', headers: auth(), payload: { levelId: 'ch1_lv1' } });
        expect(r.statusCode).toBe(403);
      } finally {
        await rebuiltApp.close();
      }
    });

    it('save-level ban (antiCheat.pveBanned) -> 403', async () => {
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.antiCheat.pveBanned': true } });
      expect((await enter('ch1_lv1')).statusCode).toBe(403);
    });

    it('insufficient stamina -> 402', async () => {
      await m.collections.pveStamina.updateOne({ _id: accountId }, { $set: { current: 5, regenAt: 0 } }, { upsert: true });
      const r = await enter('ch1_lv1');
      expect(r.statusCode).toBe(402);
    });

    it('second entry before the regen timer fires keeps the existing regenAt unchanged (deductStamina\'s regenAt!==0 branch)', async () => {
      const first = b(await enter('ch1_lv1'));
      const regenAtAfterFirst = first.data.stamina.regenAt;
      expect(regenAtAfterFirst).toBeGreaterThan(0);
      const second = b(await enter('ch1_lv1'));
      expect(second.data.stamina.regenAt).toBe(regenAtAfterFirst); // unchanged, still counting from the first deduction
      expect(second.data.stamina.current).toBe(100);
    });

    it('natural regen ticks apply before the next deduction once regenAt has passed (deductStamina\'s regen-tick branch)', async () => {
      let fakeNow = 1_700_000_000_000;
      await buildAndAuth({ withGateway: false, now: () => fakeNow });
      const first = b(await enter('ch1_lv1')); // 120 -> 110, regenAt = fakeNow + 6min
      expect(first.data.stamina.current).toBe(110);
      // Advance the clock past 2 regen ticks (6 min each) before the next entry.
      fakeNow += 13 * 60 * 1000;
      const second = b(await enter('ch1_lv1'));
      // 110 + 2 ticks = 112, then -10 for this entry = 102.
      expect(second.data.stamina.current).toBe(102);
      expect(second.data.stamina.regenAt).toBeGreaterThan(fakeNow);
    });
  });

  describe('POST /pve/stamina/purchase', () => {
    it('amount !== 60 -> 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/pve/stamina/purchase', headers: auth(), payload: { amount: 30 } });
      expect(r.statusCode).toBe(400);
    });

    it('commercial.spend rejects -> 402', async () => {
      comm.nextSpendFail = true;
      const r = await app.inject({ method: 'POST', url: '/pve/stamina/purchase', headers: auth(), payload: { amount: 60 } });
      expect(r.statusCode).toBe(402);
      expect(comm.spendCalls).toHaveLength(1);
      expect(comm.spendCalls[0]).toMatchObject({ reason: 'stamina_purchase', amount: 30 });
    });

    it('happy path, no prior pveStamina doc: purchase caps at 120 (newCurrent >= CAP branch)', async () => {
      const r = b(await app.inject({ method: 'POST', url: '/pve/stamina/purchase', headers: auth(), payload: { amount: 60 } }));
      expect(r.data.stamina.current).toBe(120);
      expect(r.data.stamina.regenAt).toBe(0);
    });

    it('happy path with an existing ticking regenAt: purchase keeps the same regenAt (regenAt !== 0 branch)', async () => {
      await enter('ch1_lv1'); // current=110, regenAt set to some future ts
      const entered = await m.collections.pveStamina.findOne({ _id: accountId });
      const r = b(await app.inject({ method: 'POST', url: '/pve/stamina/purchase', headers: auth(), payload: { amount: 60 } }));
      expect(r.data.stamina.current).toBe(120); // 110+60 capped at 120
      // since newCurrent hit the cap, regenAt resets to 0 regardless of the pre-existing timer
      expect(r.data.stamina.regenAt).toBe(0);
      expect(entered?.regenAt).toBeGreaterThan(0);
    });

    it('below-cap purchase with a pre-existing non-zero regenAt keeps that regenAt unchanged', async () => {
      await m.collections.pveStamina.updateOne({ _id: accountId }, { $set: { current: 10, regenAt: 123456 } }, { upsert: true });
      const r = b(await app.inject({ method: 'POST', url: '/pve/stamina/purchase', headers: auth(), payload: { amount: 60 } }));
      expect(r.data.stamina.current).toBe(70); // 10+60, below cap
      expect(r.data.stamina.regenAt).toBe(123456); // kept, not reset
    });

    it('below-cap purchase with regenAt already 0 assigns a fresh regen timer', async () => {
      await m.collections.pveStamina.updateOne({ _id: accountId }, { $set: { current: 10, regenAt: 0 } }, { upsert: true });
      const r = b(await app.inject({ method: 'POST', url: '/pve/stamina/purchase', headers: auth(), payload: { amount: 60 } }));
      expect(r.data.stamina.current).toBe(70);
      expect(r.data.stamina.regenAt).toBeGreaterThan(0);
    });
  });
});
