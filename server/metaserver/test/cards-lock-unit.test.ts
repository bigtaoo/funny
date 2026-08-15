// Unit-style coverage backfill for src/cards/lock.ts (2026-08-14 test-coverage task). setCardLock's
// happy paths are already exercised end-to-end by test/cards.e2e.test.ts, but that file imports
// `buildApp` from '../dist/app.js' — vitest's v8 coverage provider only source-map-attributes execution
// of modules it itself loaded via its Vite transform, so running the *compiled* dist/*.js through
// Node's own ESM loader records zero coverage against src/*.ts. This file imports directly from
// '../src/...' so the exact same exercise gets attributed correctly, plus the two branches
// cards.e2e.test.ts doesn't reach: save missing entirely, and the rev-retry loop exhausting.
//
// Real Mongo (rs0): setCardLock only needs findOne/updateOne/findOneAndUpdate — FakeCollection could
// handle the happy paths, but the exhausted-retry test below needs to wrap one real collection method
// deterministically (same trick as cards-fuse-unit.test.ts / economy-service-unit.test.ts), which reads
// more naturally against the same real driver the e2e test already validates against.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createMongo, type JwtConfig, type MongoHandle, type Collections } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import type { CommercialClient } from '../src/commercialClient.js';
import { buildApp } from '../src/app.js';
import { setCardLock } from '../src/cards.js';
import { readCardInv } from './helpers/cards.js';

function makeFakeCommercial(): CommercialClient {
  return {
    available: true,
    async getWallet() { return { coins: 0, pity: {} }; },
    async spend() { return { ok: true as const, coinsAfter: 0 }; },
  } as unknown as CommercialClient;
}

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_cards_lock_unit_test';
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
if (!mongo) console.warn(`[cards-lock-unit] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('setCardLock (src import, coverage backfill)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let accountId: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: makeFakeCommercial() });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `lock-dev-${randomUUID()}` } }));
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${r.data.token}` } });
  });
  afterAll(async () => { if (app) await app.close(); });

  it('cardInstanceId missing -> BAD_REQUEST', async () => {
    const res = await setCardLock(m.collections, () => Date.now(), accountId, '', true);
    expect(res).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('card not found -> CARD_NOT_FOUND', async () => {
    const res = await setCardLock(m.collections, () => Date.now(), accountId, 'card_does_not_exist', true);
    expect(res).toMatchObject({ code: 'CARD_NOT_FOUND' });
  });

  it('locking an unlocked card sets locked=true and bumps rev', async () => {
    const cardId = Object.keys(await readCardInv(m, accountId))[0]!;
    const before = (await m.collections.saves.findOne({ _id: accountId }))!.save.rev;
    const res = await setCardLock(m.collections, () => Date.now(), accountId, cardId, true);
    expect('error' in res).toBe(false);
    expect((res as { save: { rev: number } }).save.rev).toBe(before + 1);
    expect((await m.collections.cardInstances.findOne({ _id: cardId }))!.locked).toBe(true);
  });

  it('no-op: locking an already-locked card returns the save without writing / bumping rev', async () => {
    const cardId = Object.keys(await readCardInv(m, accountId))[0]!;
    await setCardLock(m.collections, () => Date.now(), accountId, cardId, true);
    const revAfterFirst = (await m.collections.saves.findOne({ _id: accountId }))!.save.rev;
    const res = await setCardLock(m.collections, () => Date.now(), accountId, cardId, true);
    expect('error' in res).toBe(false);
    expect((res as { save: { rev: number } }).save.rev).toBe(revAfterFirst);
  });

  it('unlocking sets locked=false', async () => {
    const cardId = Object.keys(await readCardInv(m, accountId))[0]!;
    await setCardLock(m.collections, () => Date.now(), accountId, cardId, true);
    const res = await setCardLock(m.collections, () => Date.now(), accountId, cardId, false);
    expect('error' in res).toBe(false);
    expect((await m.collections.cardInstances.findOne({ _id: cardId }))!.locked).toBe(false);
  });

  it('save missing -> NOT_FOUND (card doc exists but its save has been deleted)', async () => {
    const cardId = Object.keys(await readCardInv(m, accountId))[0]!;
    await m.collections.saves.deleteOne({ _id: accountId });
    const res = await setCardLock(m.collections, () => Date.now(), accountId, cardId, true);
    expect(res).toMatchObject({ code: 'NOT_FOUND' });
    // The card write itself already committed (unconditional, before the save rev-loop even starts).
    expect((await m.collections.cardInstances.findOne({ _id: cardId }))!.locked).toBe(true);
  });

  it('rev-retries exhausted -> REV_CONFLICT (the flag flip itself already committed)', async () => {
    const cardId = Object.keys(await readCardInv(m, accountId))[0]!;
    const real = m.collections.saves;
    const wrapped = {
      findOne: real.findOne.bind(real),
      findOneAndUpdate: async () => null,
      updateOne: real.updateOne.bind(real),
    } as typeof real;
    const wrappedCols: Collections = { ...m.collections, saves: wrapped };
    const res = await setCardLock(wrappedCols, () => Date.now(), accountId, cardId, true);
    expect(res).toMatchObject({ code: 'REV_CONFLICT' });
    expect((await m.collections.cardInstances.findOne({ _id: cardId }))!.locked).toBe(true);
  });
});
