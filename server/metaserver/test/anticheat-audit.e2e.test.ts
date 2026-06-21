// 成就反作弊离线抽查端到端（S9-7，ACHIEVEMENT_DESIGN §4.4）：真实 Mongo + 注入假 peer 裁判。
//   超报→回滚+升档+审查记录+overclaim 标记 / 重跑幂等 / clean 无记录 / 无裁判全 0 留局 /
//   裁判失败 skipped / 少报 clean / suspicion 加权抽样 / 回滚 0 下限 / 内部审查端点鉴权。
// 需 `cd server && docker compose up -d` + 先 `tsc -b`（导入 dist）。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMongo,
  makeNewSave,
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
if (!mongo) console.warn(`[anticheat-audit.e2e] Mongo 不可达（${URI}）— 跳过。`);

/** 可配假裁判：available + 固定 verdict（statsJson 为 PvP per-side map）。 */
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

  // 种一名账号存档 + 初始 stats / suspicion。
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

  // 种一局已归档 ranked（含 reportedStats + 最小内嵌 replay）。
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
      replay: {
        engineVersion: 1,
        mode: 'ranked',
        seed: '12345',
        endFrame: 1,
        frames: [],
        meta: { recordedAt: 1, winner: 0 },
      },
      reportedStats,
      ts,
    });
  }

  const getMatch = (roomId: string) => m.collections.matches.findOne({ roomId });
  const getSave = (id: string) => m.collections.saves.findOne({ _id: id });
  const getReviews = (accountId: string) =>
    m.collections.antiCheatReviews.find({ accountId }).toArray();
  // rand=0 → 永远抽中（< p0）；加权测试单独传别的。
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

  it('超报：回滚超报量 + statSuspicion=1 + lastFlaggedTs + 审查记录 + overclaim 标记', async () => {
    await seedSave('acctA', { 'kill.archer': 50 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 50 }, '1': {} });
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}', judgeAccountId: 'judge-1' };

    const res = await auditOnce(deps());
    expect(res).toMatchObject({ examined: 1, audited: 1, flagged: 1, skipped: 0 });

    const a = await getSave('acctA');
    expect(a?.save.stats?.['kill.archer']).toBe(10); // 50 → 10（回滚 40）
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

  it('重跑幂等：已 audited 的局不再处理，stats/suspicion 不变，单条审查', async () => {
    await seedSave('acctA', { 'kill.archer': 50 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 50 }, '1': {} });
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    await auditOnce(deps());
    const res2 = await auditOnce(deps());
    expect(res2).toMatchObject({ examined: 0, flagged: 0 });

    const a = await getSave('acctA');
    expect(a?.save.stats?.['kill.archer']).toBe(10); // 未二次回滚
    expect(a?.save.antiCheat?.statSuspicion).toBe(1);
    expect((await getReviews('acctA')).length).toBe(1);
  });

  it('clean：上报与复算一致 → 无审查、无升档、标 clean', async () => {
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

  it('无裁判可用：全 0 返回，局保持未审计', async () => {
    await seedSave('acctA', { 'kill.archer': 50 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 50 }, '1': {} });
    gateway.available = false;

    const res = await auditOnce(deps());
    expect(res).toMatchObject({ examined: 0, audited: 0, flagged: 0, skipped: 0 });
    expect((await getMatch('r1'))?.audited).toBeUndefined();
  });

  it('裁判失败（旧引擎/不可复算）→ 标 skipped，不回滚不升档', async () => {
    await seedSave('acctA', { 'kill.archer': 50 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 50 }, '1': {} });
    gateway.next = { ok: false };

    const res = await auditOnce(deps());
    expect(res).toMatchObject({ audited: 1, flagged: 0, skipped: 1 });
    expect((await getSave('acctA'))?.save.stats?.['kill.archer']).toBe(50); // 不动
    expect((await getMatch('r1'))?.audited?.verdict).toBe('skipped');
  });

  it('少报：玩家上报 < 复算 → clean（不追溯，不升档）', async () => {
    await seedSave('acctA', { 'kill.archer': 5 });
    await seedSave('acctB');
    await seedMatch('r1', { '0': { 'kill.archer': 5 }, '1': {} });
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":20},"1":{}}' };

    const res = await auditOnce(deps());
    expect(res).toMatchObject({ flagged: 0 });
    expect((await getMatch('r1'))?.audited?.verdict).toBe('clean');
  });

  it('suspicion 加权：rand 介于 p0/p_flagged → clean 账号局不抽、flagged 账号局抽中', async () => {
    // clean 局（双方 suspicion 0）
    await seedSave('cleanA');
    await seedSave('cleanB');
    await seedMatch('rc', { '0': {}, '1': {} }, ['cleanA', 'cleanB'], 1);
    // flagged 局（acctF suspicion 1）
    await seedSave('acctF', { 'kill.archer': 50 }, 1);
    await seedSave('acctG');
    await seedMatch('rf', { '0': { 'kill.archer': 50 }, '1': {} }, ['acctF', 'acctG'], 2);
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    // rand=0.1：p0(0.02) < 0.1 < p_flagged(0.35) → 仅 flagged 局抽中。
    const res = await auditOnce(deps({ rand: () => 0.1, sampleLimit: 10 }));
    expect(res.examined).toBe(2);
    expect(res.audited).toBe(1); // 只有 flagged 局被打标记
    expect((await getMatch('rc'))?.audited).toBeUndefined(); // clean 账号局未抽中、保留再抽
    expect((await getMatch('rf'))?.audited?.verdict).toBe('overclaim');
  });

  it('回滚 0 下限：超报 40 但当前仅 20 → stat 钳到 0，rolledBack=20 而 overclaim=40', async () => {
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

  it('GET /internal/anticheat/reviews：鉴权 + 按账号过滤', async () => {
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
});
