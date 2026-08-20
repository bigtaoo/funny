// Coverage for src/cards/fuseBatch.ts (2026-08-20). Same harness and the same reasoning as
// cards-fuse-unit.test.ts: import from '../src/...' so v8 attributes the run, and go against real
// Mongo (rs0) because what this module is actually about is the ORDER of its writes across two
// collections plus a rev-guarded save update — the things a fake collection makes least legible.
//
// What each case here pins down is a way the batch could quietly cost a player cards:
//  1. Rounds compose — a later round may consume what an earlier one produced (the whole reason the
//     roster is projected forward in memory rather than re-read per round).
//  2. A run that fails partway commits exactly the rounds before the failure and says so.
//  3. A run whose FIRST round is invalid is an error, not a "0 succeeded" success.
//  4. A retried idempotencyKey replays the count instead of fusing again.
//  5. cardInvCount is decremented once, for what was actually consumed.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createMongo, type JwtConfig, type MongoHandle,
  CARD_DEFS, FUSION_MATERIAL_COUNT,
} from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import type { CommercialClient } from '../src/commercialClient.js';
import { buildApp } from '../src/app.js';
import { fuseCardsBatch, MAX_FUSE_BATCH_ROUNDS, type FuseRound } from '../src/cards.js';
import { seedCard as seedCardDoc, readCardInv } from './helpers/cards.js';

function makeFakeCommercial(): CommercialClient {
  return {
    available: true,
    async getWallet() { return { coins: 0, pity: {}, fatePoints: 0, subscriptionExpiry: 0, starterUsed: [], firstPurchaseUsed: false, totalRechargeCents: 0 }; },
    async spend() { return { ok: true as const, coinsAfter: 0 }; },
  } as unknown as CommercialClient;
}

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_cards_fuse_batch_unit_test';
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
if (!mongo) console.warn(`[cards-fuse-batch-unit] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('fuseCardsBatch', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const now = () => Date.now();

  const post = (rounds: unknown, idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/cards/fuse-batch', headers: auth(), payload: { rounds, idempotencyKey } });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: makeFakeCommercial() });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `fuseb-dev-${randomUUID()}` } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() });
    // The starter roster is whatever the account was granted; every case below works off cards it
    // seeds itself so the counts stay readable.
    await m.collections.cardInstances.deleteMany({ accountId });
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.cardInvCount': 0 } });
  });
  afterAll(async () => { if (app) await app.close(); });

  /** Seed `n` unlocked tao-faction cards at `level`, returning their ids in creation order. */
  async function seedPool(n: number, level: number, prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `${prefix}_${i}_${randomUUID()}`;
      await seedCardDoc(m, accountId, { id, defId: 'lichuang', level, gear: {}, locked: false });
      ids.push(id);
    }
    await m.collections.saves.updateOne({ _id: accountId }, { $inc: { 'save.cardInvCount': n } });
    return ids;
  }

  /** `n` rounds at Lv.1, each spending PREP_COST_PER_CARD of `pool` (5 materials + 1 feeder). */
  function roundsFrom(pool: string[], n: number): FuseRound[] {
    const rounds: FuseRound[] = [];
    for (let i = 0; i < n; i++) {
      const slice = pool.slice(i * (FUSION_MATERIAL_COUNT + 1), (i + 1) * (FUSION_MATERIAL_COUNT + 1));
      rounds.push({ targetId: slice[0]!, materialIds: slice.slice(1) });
    }
    return rounds;
  }

  it('sanity: the seeded def is tao-faction, so same-faction rules are satisfied', () => {
    expect(CARD_DEFS.lichuang?.faction).toBe('tao');
  });

  it('runs every round in one request and decrements cardInvCount once for the whole run', async () => {
    const pool = await seedPool(3 * (FUSION_MATERIAL_COUNT + 1), 1, 'p');
    const rounds = roundsFrom(pool, 3);

    const r = body(await post(rounds, 'ik-happy'));
    expect(r.ok).toBe(true);
    expect(r.data.completed).toBe(3);
    expect(r.data.failed).toBeUndefined();

    const inv = await readCardInv(m, accountId);
    // 3 feeders survive at Lv.2; their 15 materials are gone.
    expect(Object.keys(inv)).toHaveLength(3);
    for (const round of rounds) expect(inv[round.targetId]!.level).toBe(2);
    expect(r.data.save.cardInvCount).toBe(3 * (FUSION_MATERIAL_COUNT + 1) - 3 * FUSION_MATERIAL_COUNT);
  });

  it('lets a later round consume what an earlier one produced', async () => {
    // Five Lv.1 rounds make five Lv.2 cards; a sixth round then fuses five of them into the last.
    const pool = await seedPool(6 * (FUSION_MATERIAL_COUNT + 1), 1, 'chain');
    const lowRounds = roundsFrom(pool, 6);
    const produced = lowRounds.map((r) => r.targetId);
    const rounds = [...lowRounds, { targetId: produced[5]!, materialIds: produced.slice(0, 5) }];

    const r = body(await post(rounds, 'ik-chain'));
    expect(r.ok).toBe(true);
    expect(r.data.completed).toBe(7);

    const inv = await readCardInv(m, accountId);
    expect(Object.keys(inv)).toHaveLength(1);
    expect(inv[produced[5]!]!.level, 'Lv.1 → Lv.2 → Lv.3 inside a single request').toBe(3);
  });

  it('stops at the first bad round, keeps what landed, and names the round that failed', async () => {
    const pool = await seedPool(3 * (FUSION_MATERIAL_COUNT + 1), 1, 'stop');
    const rounds = roundsFrom(pool, 3);
    // Lock one material of round 1 (0-based): round 0 must still commit, round 2 must not run.
    await m.collections.cardInstances.updateOne({ _id: rounds[1]!.materialIds[0]! }, { $set: { locked: true } });

    const res = await post(rounds, 'ik-partial');
    expect(res.statusCode, 'partial progress is a success, not an error').toBe(200);
    const r = body(res);
    expect(r.data.completed).toBe(1);
    expect(r.data.failed).toMatchObject({ index: 1, code: 'CARD_LOCKED' });

    const inv = await readCardInv(m, accountId);
    expect(inv[rounds[0]!.targetId]!.level, 'round 0 committed').toBe(2);
    expect(inv[rounds[2]!.targetId]!.level, 'round 2 never ran').toBe(1);
    expect(r.data.save.cardInvCount).toBe(3 * (FUSION_MATERIAL_COUNT + 1) - FUSION_MATERIAL_COUNT);
  });

  it('rejects outright when the FIRST round is already invalid, without claiming the key', async () => {
    const pool = await seedPool(2 * (FUSION_MATERIAL_COUNT + 1), 1, 'first');
    const rounds = roundsFrom(pool, 2);
    await m.collections.cardInstances.updateOne({ _id: rounds[0]!.materialIds[0]! }, { $set: { locked: true } });

    const res = await post(rounds, 'ik-firstbad');
    // CARD_LOCKED has no ERROR_HTTP_STATUS entry, so it falls through to 400 — same as /cards/fuse.
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe('CARD_LOCKED');
    expect(await m.collections.cardIdem.findOne({ _id: 'ik-firstbad' }), 'nothing ran ⇒ nothing claimed').toBeNull();
    expect(await m.collections.cardInstances.countDocuments({ accountId })).toBe(2 * (FUSION_MATERIAL_COUNT + 1));
  });

  it('replays a retried idempotencyKey instead of fusing again', async () => {
    const pool = await seedPool(2 * (FUSION_MATERIAL_COUNT + 1), 1, 'idem');
    const rounds = roundsFrom(pool, 2);
    const first = body(await post(rounds, 'ik-dup'));
    expect(first.data.completed).toBe(2);
    const after = await m.collections.cardInstances.countDocuments({ accountId });

    const second = body(await post(rounds, 'ik-dup'));
    expect(second.data.completed, 'the replay reports the same count').toBe(2);
    expect(await m.collections.cardInstances.countDocuments({ accountId }), 'and consumes nothing').toBe(after);
  });

  it('rejects an empty run and one past the round cap', async () => {
    expect(await (await post([], 'ik-empty')).statusCode).toBe(400);
    const tooMany = Array.from({ length: MAX_FUSE_BATCH_ROUNDS + 1 }, () => ({
      targetId: 't', materialIds: ['a', 'b', 'c', 'd', 'e'],
    }));
    expect(await (await post(tooMany, 'ik-many')).statusCode).toBe(400);
  });

  it('reports which round was malformed rather than a bare shape error', async () => {
    const pool = await seedPool(FUSION_MATERIAL_COUNT + 1, 1, 'shape');
    const [good] = roundsFrom(pool, 1);
    const res = await fuseCardsBatch(
      m.collections, now, accountId,
      [good!, { targetId: 'x', materialIds: ['a', 'b'] }],
      'ik-shape',
    );
    expect(res).toMatchObject({ code: 'BAD_REQUEST' });
    expect((res as { error: string }).error).toMatch(/^round 1:/);
  });

  it('idempotencyKey is required', async () => {
    const res = await fuseCardsBatch(m.collections, now, accountId, [{ targetId: 't', materialIds: ['a', 'b', 'c', 'd', 'e'] }], '');
    expect(res).toMatchObject({ code: 'BAD_REQUEST' });
  });
});
