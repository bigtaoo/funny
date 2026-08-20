// Unit-style coverage backfill for src/cards/fuse.ts (2026-08-14 test-coverage task). fuseCards's
// happy paths are already exercised end-to-end by test/cards.e2e.test.ts, but that file imports
// `buildApp`/`fuseCards` from '../dist/...' — vitest's v8 coverage provider only source-map-attributes
// execution of modules it itself loaded via its Vite transform, so running the *compiled* dist/*.js
// through Node's own ESM loader records zero coverage against src/*.ts even though the same logic ran.
// This file imports directly from '../src/...' so the exact same kind of exercise gets attributed
// correctly, and adds the error/edge branches cards.e2e.test.ts's happy-path-oriented scenarios don't
// reach (unknown card defs, concurrent-claim replay, rev-conflict/exhausted-retry paths).
//
// Real Mongo (rs0): fuseCards's two-document effect (target upgrade + N materials removed) plus the
// rev-guarded saves retry loop are most faithfully exercised against a real Mongo instance, mirroring
// cards.e2e.test.ts's own choice (this module needs `find({_id:{$in:[...]}})`, `deleteMany`, and
// `findOneAndUpdate` with a `rev` guard — all straightforward for FakeCollection, but the "wrap one
// collection method to deterministically force a rare race branch" trick used below is far more
// legible against the exact same real driver the e2e test already validates against).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createMongo, type JwtConfig, type MongoHandle, type Collections,
  CARD_DEFS, MAX_CARD_LEVEL, FUSION_MATERIAL_COUNT,
} from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import type { CommercialClient } from '../src/commercialClient.js';
import { buildApp } from '../src/app.js';
import { fuseCards } from '../src/cards.js';
import { seedCard as seedCardDoc, readCardInv } from './helpers/cards.js';

function makeFakeCommercial(): CommercialClient {
  return {
    available: true,
    async getWallet() { return { coins: 0, pity: {}, fatePoints: 0, subscriptionExpiry: 0, starterUsed: [], firstPurchaseUsed: false, totalRechargeCents: 0 }; },
    async spend() { return { ok: true as const, coinsAfter: 0 }; },
  } as unknown as CommercialClient;
}

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_cards_fuse_unit_test';
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
if (!mongo) console.warn(`[cards-fuse-unit] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('fuseCards (src import, coverage backfill)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  const fuse = (targetId: string, materialIds: string[], idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/cards/fuse', headers: auth(), payload: { targetId, materialIds, idempotencyKey } });

  const seedCard = async (id: string, defId: string, level = 1, locked = false): Promise<void> => {
    await seedCardDoc(m, accountId, { id, defId, level, gear: {}, locked });
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: makeFakeCommercial() });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `fuse-dev-${randomUUID()}` } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() });
  });
  afterAll(async () => { if (app) await app.close(); });

  /** Builds a full 5-material tao-faction batch at `level`, returning [targetId, materialIds]. */
  async function seedFusableSet(level = 1): Promise<{ targetId: string; materialIds: string[] }> {
    const inv = await readCardInv(m, accountId);
    const taoCards = Object.values(inv).filter((c) => CARD_DEFS[c.defId]?.faction === 'tao');
    const targetId = taoCards[0]!.id;
    const existingMaterials = taoCards.slice(1).map((c) => c.id);
    const extraIds = ['seed_m1', 'seed_m2', 'seed_m3'].map((s) => `${s}_${randomUUID()}`);
    for (const id of extraIds) await seedCard(id, 'lichuang', level);
    const materialIds = [...existingMaterials, ...extraIds];
    if (level !== 1) await m.collections.cardInstances.updateOne({ _id: targetId }, { $set: { level } });
    expect(materialIds).toHaveLength(FUSION_MATERIAL_COUNT);
    return { targetId, materialIds };
  }

  it('targetId missing -> BAD_REQUEST', async () => {
    const { materialIds } = await seedFusableSet();
    const r = await fuse('', materialIds, 'ik-1');
    expect(r.statusCode).toBe(400);
  });

  it('materialIds not an array -> BAD_REQUEST', async () => {
    const { targetId } = await seedFusableSet();
    const r = await app.inject({
      method: 'POST', url: '/cards/fuse', headers: auth(),
      payload: { targetId, materialIds: 'not-an-array', idempotencyKey: 'ik-2' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('idempotencyKey missing -> BAD_REQUEST', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const res = await fuseCards(m.collections, () => Date.now(), accountId, targetId, materialIds, '');
    expect('error' in res && res.code).toBe('BAD_REQUEST');
  });

  it('unknown target card def -> BAD_REQUEST', async () => {
    const { materialIds } = await seedFusableSet();
    const ghostTargetId = `ghost_target_${randomUUID()}`;
    await seedCard(ghostTargetId, 'not_a_real_def', 1);
    const res = await fuseCards(m.collections, () => Date.now(), accountId, ghostTargetId, materialIds, 'ik-unknown-target');
    expect(res).toMatchObject({ code: 'BAD_REQUEST' });
    expect((res as { error: string }).error).toMatch(/unknown card def/);
  });

  it('unknown material card def -> BAD_REQUEST', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const ghostMatId = `ghost_mat_${randomUUID()}`;
    await seedCard(ghostMatId, 'not_a_real_def', 1);
    const mats = [...materialIds.slice(0, FUSION_MATERIAL_COUNT - 1), ghostMatId];
    const res = await fuseCards(m.collections, () => Date.now(), accountId, targetId, mats, 'ik-unknown-mat');
    expect(res).toMatchObject({ code: 'BAD_REQUEST' });
    expect((res as { error: string }).error).toMatch(/unknown card def for material/);
  });

  it('idempotency replay: target card since deleted -> CARD_NOT_FOUND on replay', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const r1 = body(await fuse(targetId, materialIds, 'ik-replay-gone'));
    expect(r1.ok).toBe(true);
    await m.collections.cardInstances.deleteOne({ _id: targetId });
    const r2 = await fuse(targetId, materialIds, 'ik-replay-gone');
    expect(r2.statusCode).toBe(404);
    expect(body(r2).error.code).toBe('CARD_NOT_FOUND');
  });

  it('concurrent-claim race (idem doc exists with a different op) -> insertOne dup-key replay path', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const key = 'ik-concurrent-other-op';
    // A doc already exists under this _id but with a different `op` — the top-of-function replay check
    // (`replay?.op === 'fuse'`) does not short-circuit, so validation proceeds normally; the later
    // `cardIdem.insertOne` then hits a genuine duplicate-key error (11000) against this pre-existing doc,
    // exercising the "claim raced with a concurrent fuse attempt" replay branch deterministically.
    await m.collections.cardIdem.insertOne({
      _id: key, accountId, op: 'escrow', result: {}, expireAt: new Date(Date.now() + 1000_000),
    });
    const res = await fuseCards(m.collections, () => Date.now(), accountId, targetId, materialIds, key);
    expect('error' in res).toBe(false);
    expect((res as { card: { id: string } }).card.id).toBe(targetId);
    // Materials must NOT have been consumed — the dup-key branch treats this as "someone else already
    // claimed it" and replays the (unmodified) target state rather than re-running the fusion.
    for (const id of materialIds) expect(await m.collections.cardInstances.findOne({ _id: id })).toBeTruthy();
  });

  it('target changed concurrently between validation and commit -> REV_CONFLICT, no materials consumed', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const real = m.collections.cardInstances;
    const wrapped = {
      find: real.find.bind(real),
      findOne: real.findOne.bind(real),
      deleteMany: real.deleteMany.bind(real),
      updateOne: async () => ({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }),
    } as unknown as typeof real;
    const wrappedCols: Collections = { ...m.collections, cardInstances: wrapped };
    const res = await fuseCards(wrappedCols, () => Date.now(), accountId, targetId, materialIds, 'ik-rev-conflict');
    expect(res).toMatchObject({ code: 'REV_CONFLICT' });
    // The idem claim was rolled back and no material was actually deleted (real collection, unwrapped read).
    for (const id of materialIds) expect(await m.collections.cardInstances.findOne({ _id: id })).toBeTruthy();
    expect(await m.collections.cardIdem.findOne({ _id: 'ik-rev-conflict' })).toBeNull();
  });

  it('save disappears before the cardInvCount retry loop -> NOT_FOUND (fusion itself already committed)', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const real = m.collections.saves;
    let calls = 0;
    const wrapped = {
      findOne: async (q: Record<string, unknown>) => {
        calls++;
        return calls === 1 ? real.findOne(q) : null; // 1st call = getOrCreateSave pre-validation; 2nd = the rev loop
      },
      findOneAndUpdate: real.findOneAndUpdate.bind(real),
      updateOne: real.updateOne.bind(real),
    } as typeof real;
    const wrappedCols: Collections = { ...m.collections, saves: wrapped };
    const res = await fuseCards(wrappedCols, () => Date.now(), accountId, targetId, materialIds, 'ik-save-gone');
    expect(res).toMatchObject({ code: 'NOT_FOUND' });
    // Target upgrade + material deletion already committed unconditionally before this loop ran.
    const t = await m.collections.cardInstances.findOne({ _id: targetId });
    expect(t!.level).toBe(2);
    for (const id of materialIds) expect(await m.collections.cardInstances.findOne({ _id: id })).toBeNull();
  });

  it('cardInvCount rev-retries exhausted -> reports success anyway (fusion already committed, self-healing mirror)', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const before = (await m.collections.cardInstances.findOne({ _id: targetId }))!.level;
    const realSaves = m.collections.saves;
    const wrappedSaves = {
      findOne: realSaves.findOne.bind(realSaves),
      findOneAndUpdate: async () => null,
      updateOne: realSaves.updateOne.bind(realSaves),
    } as unknown as typeof realSaves;
    const wrappedCols: Collections = { ...m.collections, saves: wrappedSaves };
    const result = await fuseCards(wrappedCols, () => Date.now(), accountId, targetId, materialIds, 'ik-fuse-exhaust-src');
    expect('error' in result).toBe(false);
    expect((result as { card: { level: number } }).card.level).toBe(before + 1);
    for (const id of materialIds) expect(await m.collections.cardInstances.findOne({ _id: id })).toBeNull();
    // Retry with the same key against the real (unwrapped) collections replays the actual fused state.
    const retry = body(await fuse(targetId, materialIds, 'ik-fuse-exhaust-src'));
    expect(retry.ok).toBe(true);
    expect(retry.data.card.level).toBe(before + 1);
  });

  it('materialIds.length !== FUSION_MATERIAL_COUNT (direct call) -> BAD_REQUEST', async () => {
    const { materialIds } = await seedFusableSet();
    const res = await fuseCards(m.collections, () => Date.now(), accountId, 'whatever', materialIds.slice(0, 2), 'ik-count');
    expect(res).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('material = target (direct call) -> BAD_REQUEST', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const mats = [targetId, ...materialIds.slice(1)];
    const res = await fuseCards(m.collections, () => Date.now(), accountId, targetId, mats, 'ik-self-src');
    expect(res).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('duplicate material ids (direct call) -> BAD_REQUEST', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const mats = [materialIds[0]!, materialIds[0]!, materialIds[1]!, materialIds[2]!, materialIds[3]!];
    const res = await fuseCards(m.collections, () => Date.now(), accountId, targetId, mats, 'ik-dup-src');
    expect(res).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('material not found -> CARD_NOT_FOUND', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const mats = [...materialIds.slice(0, FUSION_MATERIAL_COUNT - 1), 'card_does_not_exist'];
    const res = await fuseCards(m.collections, () => Date.now(), accountId, targetId, mats, 'ik-mat-missing');
    expect(res).toMatchObject({ code: 'CARD_NOT_FOUND' });
  });

  it('locked material -> CARD_LOCKED', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    await m.collections.cardInstances.updateOne({ _id: materialIds[0] }, { $set: { locked: true } });
    const res = await fuseCards(m.collections, () => Date.now(), accountId, targetId, materialIds, 'ik-locked-src');
    expect(res).toMatchObject({ code: 'CARD_LOCKED' });
  });

  it('cross-faction material -> WRONG_FACTION', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const annaCardId = `anna_${randomUUID()}`;
    await seedCard(annaCardId, 'max', 1);
    const mats = [...materialIds.slice(0, FUSION_MATERIAL_COUNT - 1), annaCardId];
    const res = await fuseCards(m.collections, () => Date.now(), accountId, targetId, mats, 'ik-faction-src');
    expect(res).toMatchObject({ code: 'WRONG_FACTION' });
  });

  it('material level mismatch -> BAD_REQUEST', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    await m.collections.cardInstances.updateOne({ _id: materialIds[0] }, { $set: { level: 5 } });
    const res = await fuseCards(m.collections, () => Date.now(), accountId, targetId, materialIds, 'ik-lvmismatch-src');
    expect(res).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('target already at MAX_CARD_LEVEL -> BAD_REQUEST', async () => {
    const { targetId, materialIds } = await seedFusableSet(MAX_CARD_LEVEL);
    const res = await fuse(targetId, materialIds, 'ik-maxlevel-src');
    expect(res.statusCode).toBe(400);
  });

  it('happy path via direct fuseCards call mirrors the HTTP happy path', async () => {
    const { targetId, materialIds } = await seedFusableSet();
    const before = (await m.collections.cardInstances.findOne({ _id: targetId }))!.level;
    const res = await fuseCards(m.collections, () => Date.now(), accountId, targetId, materialIds, 'ik-direct-happy');
    expect('error' in res).toBe(false);
    expect((res as { card: { level: number } }).card.level).toBe(before + 1);
    for (const id of materialIds) expect(await m.collections.cardInstances.findOne({ _id: id })).toBeNull();
  });
});
