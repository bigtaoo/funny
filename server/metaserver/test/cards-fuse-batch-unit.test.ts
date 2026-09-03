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
//  6. Every way the run can end badly *after* it started writing — mid-batch REV_CONFLICT, a save
//     that vanished, exhausted rev retries, a key another request claimed first — leaves the
//     already-committed rounds committed and replayable, never re-fusable.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createMongo, type JwtConfig, type MongoHandle, type Collections,
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

  it('reads the roster exactly once, however many rounds it runs', async () => {
    // This is the property the endpoint exists for, and nothing else asserts it: a correct-but-
    // per-round implementation would pass every other case in this file while costing one roster
    // read (and, over HTTP, one full cardInv reassembly) per fusion — the original stall.
    const pool = await seedPool(3 * (FUSION_MATERIAL_COUNT + 1), 1, 'reads');
    const real = m.collections.cardInstances;
    let finds = 0;
    const wrapped = {
      find: (...args: unknown[]) => { finds++; return (real.find as (...a: unknown[]) => unknown)(...args); },
      findOne: real.findOne.bind(real),
      updateOne: real.updateOne.bind(real),
      deleteMany: real.deleteMany.bind(real),
      countDocuments: real.countDocuments.bind(real),
    } as unknown as typeof real;

    const res = await fuseCardsBatch(
      { ...m.collections, cardInstances: wrapped }, now, accountId, roundsFrom(pool, 3), 'ik-reads',
    );
    expect(res).toMatchObject({ completed: 3 });
    expect(finds, 'one find for the whole batch, not one per round').toBe(1);
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
    // 409, matching EQUIP_LOCKED — the equipment twin of this same "it's locked, unlock it first"
    // refusal (ERROR_HTTP_STATUS gained the card-side entry on 2026-09-03).
    expect(res.statusCode).toBe(409);
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

  it('rejects an empty run and one past the round cap over HTTP', async () => {
    expect(await (await post([], 'ik-empty')).statusCode).toBe(400);
    const tooMany = Array.from({ length: MAX_FUSE_BATCH_ROUNDS + 1 }, () => ({
      targetId: 't', materialIds: ['a', 'b', 'c', 'd', 'e'],
    }));
    expect(await (await post(tooMany, 'ik-many')).statusCode).toBe(400);
  });

  it('enforces the same two bounds itself, not only through the request schema', async () => {
    // The HTTP case above is satisfied by openapi's minItems/maxItems before the handler ever runs,
    // which means it proves nothing about the function — and the function is what worldsvc-style
    // internal callers and any future non-HTTP entry would go through. Call it directly.
    const dummy = { targetId: 't', materialIds: ['a', 'b', 'c', 'd', 'e'] };
    expect(await fuseCardsBatch(m.collections, now, accountId, [], 'ik-d-empty'))
      .toMatchObject({ code: 'BAD_REQUEST' });
    expect(await fuseCardsBatch(m.collections, now, accountId, null as unknown as FuseRound[], 'ik-d-null'))
      .toMatchObject({ code: 'BAD_REQUEST' });
    const overCap = Array.from({ length: MAX_FUSE_BATCH_ROUNDS + 1 }, () => dummy);
    expect(await fuseCardsBatch(m.collections, now, accountId, overCap, 'ik-d-many'))
      .toMatchObject({ code: 'BAD_REQUEST' });
    // ...and the cap itself is inclusive: exactly MAX rounds gets past the bound (and then fails on
    // the cards not existing, which is a different, later check — that's the point).
    const atCap = Array.from({ length: MAX_FUSE_BATCH_ROUNDS }, () => dummy);
    expect(await fuseCardsBatch(m.collections, now, accountId, atCap, 'ik-d-atcap'))
      .toMatchObject({ code: 'CARD_NOT_FOUND' });
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

  it('a plan that spends the same card in two rounds is stopped at the second, not honoured', async () => {
    // The realistic bad plan: the client's projection drifted, or a hand-rolled request tries to
    // double-spend. Because the roster is projected forward in memory, round 1's material is already
    // gone from the map when round 1 is checked — so it must fail there rather than deleting nothing
    // and levelling the target for free.
    const pool = await seedPool(2 * (FUSION_MATERIAL_COUNT + 1), 1, 'dup');
    const [r0, r1] = roundsFrom(pool, 2);
    const overlapping = [r0!, { targetId: r1!.targetId, materialIds: [...r0!.materialIds] }];

    const r = body(await post(overlapping, 'ik-doublespend'));
    expect(r.data.completed).toBe(1);
    expect(r.data.failed).toMatchObject({ index: 1, code: 'CARD_NOT_FOUND' });
    const inv = await readCardInv(m, accountId);
    expect(inv[r1!.targetId]!.level, 'the second target was not levelled for free').toBe(1);
  });

  it('cannot reach across accounts, even for a card id that really exists', async () => {
    // The batch reads the roster ONCE with an accountId filter; anything outside it is simply absent
    // from the map, so a foreign id has to read as CARD_NOT_FOUND rather than as a usable card.
    const pool = await seedPool(FUSION_MATERIAL_COUNT + 1, 1, 'mine');
    const other = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `other-${randomUUID()}` } }));
    const foreignId = `foreign_${randomUUID()}`;
    await seedCardDoc(m, other.data.accountId, { id: foreignId, defId: 'lichuang', level: 1, gear: {}, locked: false });

    const [mine] = roundsFrom(pool, 1);
    const rounds = [{ targetId: mine!.targetId, materialIds: [...mine!.materialIds.slice(1), foreignId] }];
    const res = await post(rounds, 'ik-foreign');
    expect(body(res).error.code).toBe('CARD_NOT_FOUND');
    expect(await m.collections.cardInstances.findOne({ _id: foreignId }), 'and the other account keeps its card').toBeTruthy();
  });

  it('a key another request already claimed replays that run instead of re-fusing', async () => {
    // Deterministic stand-in for the concurrent-retry race: a doc already sits under this _id (here
    // written by a single-shot fuse, so it carries no round count), the top-of-function replay check
    // doesn't match its `op`, and the claim insert then hits a genuine duplicate key.
    const pool = await seedPool(2 * (FUSION_MATERIAL_COUNT + 1), 1, 'race');
    const rounds = roundsFrom(pool, 2);
    const key = 'ik-raced';
    await m.collections.cardIdem.insertOne({
      _id: key, accountId, op: 'fuse', result: { targetId: 'whatever' }, expireAt: new Date(Date.now() + 1000_000),
    });

    const r = body(await post(rounds, key));
    expect(r.ok).toBe(true);
    expect(r.data.completed, 'no round count stored under that key ⇒ report nothing landed').toBe(0);
    expect(
      await m.collections.cardInstances.countDocuments({ accountId }),
      'and above all: consume nothing',
    ).toBe(2 * (FUSION_MATERIAL_COUNT + 1));
  });

  it('does not swallow a claim failure that is not a duplicate key', async () => {
    // The dup-key branch means "someone else owns this run" and returns a 200 with completed:0. Any
    // OTHER driver error reaching that catch must not be reported the same way — "nothing happened,
    // all good" would be a lie about a write we never even attempted.
    const pool = await seedPool(FUSION_MATERIAL_COUNT + 1, 1, 'boom');
    const real = m.collections.cardIdem;
    const wrapped = {
      findOne: real.findOne.bind(real),
      insertOne: async () => { throw new Error('connection reset'); },
      updateOne: real.updateOne.bind(real),
    } as unknown as typeof real;
    const cols: Collections = { ...m.collections, cardIdem: wrapped };

    await expect(fuseCardsBatch(cols, now, accountId, roundsFrom(pool, 1), 'ik-boom')).rejects.toThrow('connection reset');
    expect(await m.collections.cardInstances.countDocuments({ accountId }), 'nothing consumed').toBe(FUSION_MATERIAL_COUNT + 1);
  });

  it('a REV_CONFLICT partway keeps the earlier rounds AND keeps them replayable', async () => {
    // Differs deliberately from single-shot fuseCards, which rolls its idem claim back on
    // REV_CONFLICT: here rounds before the conflict really did commit, so the claim must survive
    // carrying their count — rolling it back would let a retry fuse them a second time.
    const pool = await seedPool(3 * (FUSION_MATERIAL_COUNT + 1), 1, 'rev');
    const rounds = roundsFrom(pool, 3);
    const real = m.collections.cardInstances;
    let updates = 0;
    const wrapped = {
      find: real.find.bind(real),
      findOne: real.findOne.bind(real),
      deleteMany: real.deleteMany.bind(real),
      updateOne: async (...args: unknown[]) => (++updates === 1
        ? (real.updateOne as (...a: unknown[]) => unknown)(...args)
        : { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }),
    } as unknown as typeof real;
    const cols: Collections = { ...m.collections, cardInstances: wrapped };

    const res = await fuseCardsBatch(cols, now, accountId, rounds, 'ik-rev');
    expect(res).toMatchObject({ completed: 1, failed: { index: 1, code: 'REV_CONFLICT' } });
    const claim = await m.collections.cardIdem.findOne({ _id: 'ik-rev' });
    expect(claim?.result, 'the claim survives, carrying what landed').toMatchObject({ rounds: 1 });

    // The retry (real collections this time) must replay that 1, not fuse anything else.
    const before = await m.collections.cardInstances.countDocuments({ accountId });
    const retry = body(await post(rounds, 'ik-rev'));
    expect(retry.data.completed).toBe(1);
    expect(await m.collections.cardInstances.countDocuments({ accountId })).toBe(before);
  });

  it('save gone before the count decrement -> NOT_FOUND, but the run is already banked', async () => {
    const pool = await seedPool(2 * (FUSION_MATERIAL_COUNT + 1), 1, 'savegone');
    const rounds = roundsFrom(pool, 2);
    const real = m.collections.saves;
    let reads = 0;
    const wrapped = {
      findOne: async (query: Record<string, unknown>) => (++reads === 1 ? real.findOne(query) : null),
      findOneAndUpdate: real.findOneAndUpdate.bind(real),
      updateOne: real.updateOne.bind(real),
    } as typeof real;

    const res = await fuseCardsBatch({ ...m.collections, saves: wrapped }, now, accountId, rounds, 'ik-savegone');
    expect(res).toMatchObject({ code: 'NOT_FOUND' });
    // The fusions committed before that loop ran, and — unlike the error suggests — they are banked:
    // the claim was already updated, so the client's retry replays instead of spending the cards twice.
    for (const round of rounds) {
      expect((await m.collections.cardInstances.findOne({ _id: round.targetId }))!.level).toBe(2);
    }
    const retry = body(await post(rounds, 'ik-savegone'));
    expect(retry.data.completed).toBe(2);
  });

  it('exhausted rev retries still report the run that committed', async () => {
    // cardInvCount is an informational mirror that self-heals via assembleCardInv; failing the whole
    // call over it would tell the player nothing happened when in fact their cards are gone.
    const pool = await seedPool(2 * (FUSION_MATERIAL_COUNT + 1), 1, 'exhaust');
    const rounds = roundsFrom(pool, 2);
    const real = m.collections.saves;
    const wrapped = {
      findOne: real.findOne.bind(real),
      findOneAndUpdate: async () => null,
      updateOne: real.updateOne.bind(real),
    } as unknown as typeof real;

    const res = await fuseCardsBatch({ ...m.collections, saves: wrapped }, now, accountId, rounds, 'ik-exhaust');
    expect(res).toMatchObject({ completed: 2 });
    expect('error' in res).toBe(false);
    expect((res as { save: { accountId: string } }).save.accountId, 'falls back to a freshly read save').toBe(accountId);
    for (const round of rounds) {
      expect((await m.collections.cardInstances.findOne({ _id: round.targetId }))!.level).toBe(2);
    }
  });
});
