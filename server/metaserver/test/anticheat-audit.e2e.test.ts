// Achievement anti-cheat offline spot-check end-to-end (S9-7, ACHIEVEMENT_DESIGN §4.4): real Mongo + injected fake peer judge.
//   overclaim → rollback + suspicion increment + review record + overclaim marker / idempotent rerun / clean leaves no record / no judge → all-zero, match stays unaudited /
//   judge failure → skipped / underreport → clean / suspicion-weighted sampling / rollback floor at 0 / internal review endpoint auth.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMongo,
  makeNewSave,
  compressReplayDoc,
  type JwtConfig,
  type MongoHandle,
  type MatchDoc,
  type SaveData,
} from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import { auditOnce } from '../dist/anticheatAudit.js';
import type { GatewayClient, JudgeReq, JudgeRes } from '../dist/gatewayClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_anticheat_test';
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
if (!mongo) console.warn(`[anticheat-audit.e2e] Mongo unreachable (${URI}) — skipping.`);

/** Configurable fake judge: available flag + fixed verdict (statsJson is a PvP per-side map). */
class FakeGateway implements GatewayClient {
  available = true;
  next: JudgeRes = { ok: true, statsJson: '{}', judgeAccountId: 'judge-1' };
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

describe.skipIf(!mongo)('anti-cheat offline audit e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let gateway: FakeGateway;
  const now = () => 1000;

  // Seed one account save with optional initial stats / suspicion.
  async function seedSave(
    accountId: string,
    stats?: SaveData['stats'],
    statSuspicion?: number,
  ): Promise<void> {
    const save = makeNewSave(accountId, now());
    if (stats) save.stats = stats;
    if (statSuspicion) save.antiCheat = { statSuspicion };
    await m.collections.saves.insertOne({ _id: accountId, save, rev: save.rev });
  }

  // Seed one archived ranked match (with reportedStats + minimal embedded replay).
  async function seedMatch(
    roomId: string,
    reportedStats: MatchDoc['reportedStats'],
    accounts: [string, string] = ['acctA', 'acctB'],
    ts = 1,
  ): Promise<void> {
    await m.collections.matches.insertOne({
      roomId,
      mode: 'ranked',
      seed: '12345',
      players: [
        { side: 0, accountId: accounts[0], publicId: '100000001' },
        { side: 1, accountId: accounts[1], publicId: '100000002' },
      ],
      winner: 0,
      reason: 'base',
      hashOk: true,
      replayGz: compressReplayDoc({
        engineVersion: 1,
        mode: 'ranked',
        seed: '12345',
        endFrame: 1,
        frames: [],
        meta: { recordedAt: 1, winner: 0 },
      }),
      reportedStats,
      ts,
    });
  }

  const getMatch = (roomId: string) => m.collections.matches.findOne({ roomId });
  const getSave = (id: string) => m.collections.saves.findOne({ _id: id });
  const getReviews = (accountId: string) =>
    m.collections.antiCheatReviews.find({ accountId }).toArray();
  // rand=0 → always sampled (< p0); weighted tests pass a different value.
  const deps = (over?: Partial<Parameters<typeof auditOnce>[0]>) => ({
    cols: m.collections,
    gateway,
    now,
    rand: () => 0,
    ...over,
  });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    gateway = new FakeGateway();
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY, gateway });
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it('overclaim: rollback excess + statSuspicion=1 + lastFlaggedTs + review record + overclaim marker', async () => {
    await seedSave('acctA', { 'kill.archer': 50 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 50 }, '1': {} });
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}', judgeAccountId: 'judge-1' };

    const res = await auditOnce(deps());
    expect(res).toMatchObject({ examined: 1, audited: 1, flagged: 1, skipped: 0 });

    const a = await getSave('acctA');
    expect(a?.save.stats?.['kill.archer']).toBe(10); // 50 → 10 (rolled back by 40)
    expect(a?.save.antiCheat?.statSuspicion).toBe(1);
    expect(a?.save.antiCheat?.lastFlaggedTs).toBe(1000);

    const reviews = await getReviews('acctA');
    expect(reviews.length).toBe(1);
    expect(reviews[0].overclaim).toEqual({ 'kill.archer': 40 });
    expect(reviews[0].rolledBack).toEqual({ 'kill.archer': 40 });
    expect(reviews[0].suspicionAfter).toBe(1);
    expect(reviews[0].status).toBe('open');

    const match = await getMatch('r1');
    expect(match?.audited?.verdict).toBe('overclaim');
    expect(match?.audited?.overclaim).toEqual({ '0': { 'kill.archer': 40 } });
  });

  it('idempotent rerun: already-audited match is not re-processed; stats/suspicion unchanged, single review record', async () => {
    await seedSave('acctA', { 'kill.archer': 50 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 50 }, '1': {} });
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    await auditOnce(deps());
    const res2 = await auditOnce(deps());
    expect(res2).toMatchObject({ examined: 0, flagged: 0 });

    const a = await getSave('acctA');
    expect(a?.save.stats?.['kill.archer']).toBe(10); // not rolled back a second time
    expect(a?.save.antiCheat?.statSuspicion).toBe(1);
    expect((await getReviews('acctA')).length).toBe(1);
  });

  it('clean: report matches recompute → no review, no suspicion increase, marked clean', async () => {
    await seedSave('acctA', { 'kill.archer': 10 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 10 }, '1': {} });
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps());
    expect(res).toMatchObject({ audited: 1, flagged: 0, skipped: 0 });
    expect((await getSave('acctA'))?.save.antiCheat).toBeUndefined();
    expect((await getReviews('acctA')).length).toBe(0);
    expect((await getMatch('r1'))?.audited?.verdict).toBe('clean');
  });

  it('no judge available: all zeros returned, match stays unaudited', async () => {
    await seedSave('acctA', { 'kill.archer': 50 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 50 }, '1': {} });
    gateway.available = false;

    const res = await auditOnce(deps());
    expect(res).toMatchObject({ examined: 0, audited: 0, flagged: 0, skipped: 0 });
    expect((await getMatch('r1'))?.audited).toBeUndefined();
  });

  it('judge failure (old engine / cannot recompute) → marked skipped, no rollback or suspicion increase', async () => {
    await seedSave('acctA', { 'kill.archer': 50 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 50 }, '1': {} });
    gateway.next = { ok: false };

    const res = await auditOnce(deps());
    expect(res).toMatchObject({ audited: 1, flagged: 0, skipped: 1 });
    expect((await getSave('acctA'))?.save.stats?.['kill.archer']).toBe(50); // unchanged
    expect((await getMatch('r1'))?.audited?.verdict).toBe('skipped');
  });

  it('underreport: player reported < recomputed → clean (no retroactive credit, no suspicion increase)', async () => {
    await seedSave('acctA', { 'kill.archer': 5 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 5 }, '1': {} });
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":20},"1":{}}' };

    const res = await auditOnce(deps());
    expect(res).toMatchObject({ flagged: 0 });
    expect((await getMatch('r1'))?.audited?.verdict).toBe('clean');
  });

  it('suspicion-weighted sampling: rand between p0/p_flagged → clean account match skipped, flagged account match sampled', async () => {
    // clean match (both players suspicion 0)
    await seedSave('cleanA');
    await seedSave('cleanB');
    await seedMatch('rc', { '0': {}, '1': {} }, ['cleanA', 'cleanB'], 1);
    // flagged match (acctF suspicion 1)
    await seedSave('acctF', { 'kill.archer': 50 }, 1);
    await seedSave('acctG');
    await seedMatch('rf', { '0': { 'kill.archer': 50 }, '1': {} }, ['acctF', 'acctG'], 2);
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    // rand=0.1: p0(0.02) < 0.1 < p_flagged(0.35) → only the flagged match is sampled.
    const res = await auditOnce(deps({ rand: () => 0.1, sampleLimit: 10 }));
    expect(res.examined).toBe(2);
    expect(res.audited).toBe(1); // only the flagged match is marked
    expect((await getMatch('rc'))?.audited).toBeUndefined(); // clean account match not sampled; remains available for a future sample
    expect((await getMatch('rf'))?.audited?.verdict).toBe('overclaim');
  });

  it('rollback floor at 0: overclaim of 40 but current stat only 20 → stat clamped to 0, rolledBack=20 while overclaim=40', async () => {
    await seedSave('acctA', { 'kill.archer': 20 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 60 }, '1': {} });
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":20},"1":{}}' };

    await auditOnce(deps());
    expect((await getSave('acctA'))?.save.stats?.['kill.archer']).toBe(0);
    const reviews = await getReviews('acctA');
    expect(reviews[0].overclaim).toEqual({ 'kill.archer': 40 });
    expect(reviews[0].rolledBack).toEqual({ 'kill.archer': 20 });
  });

  it('GET /internal/anticheat/reviews: auth guard + filter by accountId', async () => {
    await seedSave('acctA', { 'kill.archer': 50 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 50 }, '1': {} });
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };
    await auditOnce(deps());

    const unauth = await app.inject({ method: 'GET', url: '/internal/anticheat/reviews' });
    expect(unauth.statusCode).toBe(401);

    const r = await app.inject({
      method: 'GET',
      url: '/internal/anticheat/reviews?accountId=acctA',
      headers: { 'x-internal-key': KEY },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { reviews: { accountId: string }[] };
    expect(body.reviews.length).toBe(1);
    expect(body.reviews[0].accountId).toBe('acctA');
  });

  it('POST /internal/anticheat/reviews/:id/resolve: auth guard + marks resolved + rejects unknown id/resolution (2026-07-18 human-review policy)', async () => {
    await seedSave('acctA', { 'kill.archer': 50 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 50 }, '1': {} });
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };
    await auditOnce(deps());
    const id = (await getReviews('acctA'))[0]._id;

    const unauth = await app.inject({ method: 'POST', url: `/internal/anticheat/reviews/${id}/resolve`, payload: { resolution: 'dismissed' } });
    expect(unauth.statusCode).toBe(401);

    const badResolution = await app.inject({
      method: 'POST',
      url: `/internal/anticheat/reviews/${id}/resolve`,
      headers: { 'x-internal-key': KEY },
      payload: { resolution: 'ban-please' },
    });
    expect(badResolution.statusCode).toBe(400);

    const notFound = await app.inject({
      method: 'POST',
      url: '/internal/anticheat/reviews/no-such-review/resolve',
      headers: { 'x-internal-key': KEY },
      payload: { resolution: 'dismissed' },
    });
    expect(notFound.statusCode).toBe(404);

    const r = await app.inject({
      method: 'POST',
      url: `/internal/anticheat/reviews/${id}/resolve`,
      headers: { 'x-internal-key': KEY },
      payload: { resolution: 'dismissed', resolvedBy: 'admin-1' },
    });
    expect(r.statusCode).toBe(200);
    const updated = await getReviews('acctA');
    expect(updated[0]).toMatchObject({ status: 'reviewed', resolution: 'dismissed', resolvedBy: 'admin-1' });
  });
});
