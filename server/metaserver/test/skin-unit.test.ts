// Unit-style coverage backfill for src/skin.ts (2026-08-14 test-coverage task). escrowSkin/grantSkin's
// happy paths are already exercised end-to-end by test/skin.e2e.test.ts — but that file imports
// `buildApp` from '../dist/app.js': vitest's
// v8 coverage provider only source-map-attributes execution of modules it itself loaded via its Vite
// transform, so running the *compiled* dist/*.js through Node's own ESM loader records zero coverage
// against src/*.ts even though the same logic ran. This file imports directly from '../src/...' so the
// exact same kind of exercise gets attributed correctly, re-covers the same happy/error paths (since
// none of that attributes to src either from the other file), and adds the branches skin.e2e.test.ts's
// scenarios don't reach: assembleSkinCounts's legacy self-heal + best-effort-catch, the "concurrently
// escrowed" inner-replay race, grantSkin's already-instance / already-in-inventory no-write branches,
// and every rev-conflict/exhausted-retry / duplicate-key race across both functions.
//
// Real Mongo (rs0): this module's escrow/grant flows all use plain findOne/updateOne/
// findOneAndUpdate/insertOne/deleteOne — FakeCollection could handle the happy paths, but several rare
// races below are exercised by deterministically wrapping one real collection method (same trick as
// cards-fuse-unit.test.ts / economy-service-unit.test.ts), which reads more naturally against the same
// real driver skin.e2e.test.ts already validates against, and needs no new operator support.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createMongo, type JwtConfig, type MongoHandle, type Collections, type SkinInstance } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import {
  toInstanceDoc, countSkinInstances, assembleSkinCounts, escrowSkin, grantSkin,
} from '../src/skin.js';
import type { CommercialClient } from '../src/commercialClient.js';

/** Fake commercial with a working, orderId-idempotent `grant()` — mirrors skin.e2e.test.ts's fake. */
function makeFakeCommercialWithWallet(available = true): CommercialClient & { coins: Map<string, number>; grantedOrders: Set<string> } {
  const coins = new Map<string, number>();
  const grantedOrders = new Set<string>();
  return {
    available,
    coins,
    grantedOrders,
    async getWallet(accountId: string) { return { coins: coins.get(accountId) ?? 0 } as never; },
    async spend() { return { ok: false as const, error: 'NOT_IMPLEMENTED' }; },
    async grant(a: { accountId: string; amount: number; orderId: string }) {
      if (!grantedOrders.has(a.orderId)) {
        grantedOrders.add(a.orderId);
        coins.set(a.accountId, (coins.get(a.accountId) ?? 0) + a.amount);
      }
      return { ok: true as const, coinsAfter: coins.get(a.accountId) ?? 0 };
    },
  } as unknown as CommercialClient & { coins: Map<string, number>; grantedOrders: Set<string> };
}

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_skin_unit_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const IK = 'k';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[skin-unit] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('skin.ts (src import, coverage backfill)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let comm: ReturnType<typeof makeFakeCommercialWithWallet>;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const now = () => Date.now();

  const seedSkins = (skins: string[], account = accountId) =>
    m.collections.saves.updateOne({ _id: account }, { $set: { 'save.inventory.skins': skins } });
  const seedEquipped = (equipped: Record<string, string>, account = accountId) =>
    m.collections.saves.updateOne({ _id: account }, { $set: { 'save.equipped': equipped } });
  const readSave = async (account = accountId) => (await m.collections.saves.findOne({ _id: account }))!.save;
  const seedSkinInstances = (skinId: string, count: number, account = accountId, prefix = 'inst') =>
    m.collections.skinInstances.insertMany(
      Array.from({ length: count }, (_, i) => ({ _id: `${prefix}_${skinId}_${i}_${randomUUID()}`, accountId: account, skinId, sourceType: 'test' })),
    );

  const escrowHttp = (skinId: string, orderId: string, account = accountId) =>
    app.inject({ method: 'POST', url: '/internal/skins/escrow', headers: { 'x-internal-key': IK }, payload: { accountId: account, skinId, orderId } });
  const grantHttp = (skinId: string, orderId: string, account = accountId) =>
    app.inject({ method: 'POST', url: '/internal/skins/grant', headers: { 'x-internal-key': IK }, payload: { accountId: account, skinId, orderId } });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    comm = makeFakeCommercialWithWallet();
    app = await buildApp({ cols: m.collections, jwt, internalKey: IK, commercial: comm });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `skin-dev-${randomUUID()}` } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() });
  });
  afterAll(async () => { if (app) await app.close(); });

  // ── toInstanceDoc ──────────────────────────────────────────────────────────────────────────────
  describe('toInstanceDoc', () => {
    it('round-trips a minimal instance without introducing undefined keys', () => {
      const inst: SkinInstance = { id: 'i1', skinId: 'skin_x' };
      const doc = toInstanceDoc(inst, accountId);
      expect(doc).toEqual({ _id: 'i1', accountId, skinId: 'skin_x' });
      expect('sourceType' in doc).toBe(false);
      expect('obtainedAt' in doc).toBe(false);
    });

    it('includes sourceType/obtainedAt when present', () => {
      const inst: SkinInstance = { id: 'i2', skinId: 'skin_y', sourceType: 'gacha', obtainedAt: 12345 };
      const doc = toInstanceDoc(inst, accountId);
      expect(doc.sourceType).toBe('gacha');
      expect(doc.obtainedAt).toBe(12345);
    });
  });

  // ── countSkinInstances ─────────────────────────────────────────────────────────────────────────
  it('countSkinInstances counts only this account+skinId', async () => {
    await seedSkinInstances('skin_a', 3);
    await seedSkinInstances('skin_b', 1);
    expect(await countSkinInstances(m.collections, accountId, 'skin_a')).toBe(3);
    expect(await countSkinInstances(m.collections, accountId, 'skin_ghost')).toBe(0);
  });

  // ── assembleSkinCounts ─────────────────────────────────────────────────────────────────────────
  describe('assembleSkinCounts', () => {
    it('counts real instance rows per skinId', async () => {
      await seedSkinInstances('skin_a', 2);
      await seedSkinInstances('skin_b', 1);
      const save = await readSave();
      const counts = await assembleSkinCounts(m.collections, accountId, save);
      expect(counts).toMatchObject({ skin_a: 2, skin_b: 1 });
    });

    it('legacy self-heal: backfills exactly one instance per inventory.skins entry with zero rows', async () => {
      await seedSkins(['skin_legacy1', 'skin_legacy2']);
      const save = await readSave();
      const counts = await assembleSkinCounts(m.collections, accountId, save);
      expect(counts).toMatchObject({ skin_legacy1: 1, skin_legacy2: 1 });
      expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_legacy1' })).toBe(1);
      // Re-running is idempotent (upsert via $setOnInsert) — does not mint a second instance.
      const counts2 = await assembleSkinCounts(m.collections, accountId, save);
      expect(counts2.skin_legacy1).toBe(1);
      expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_legacy1' })).toBe(1);
    });

    it('exposed through GET /save as skinCounts for a legacy account', async () => {
      await seedSkins(['skin_legacy3']);
      const r = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
      expect(r.data.save.skinCounts.skin_legacy3).toBe(1);
    });

    it('best-effort backfill: a failed upsert for one missing skin is swallowed, still counted as 1', async () => {
      await seedSkins(['skin_will_fail']);
      const real = m.collections.skinInstances;
      const wrapped = {
        find: real.find.bind(real),
        updateOne: async () => { throw new Error('simulated write failure'); },
      } as unknown as typeof real;
      const wrappedCols: Collections = { ...m.collections, skinInstances: wrapped };
      const save = await readSave();
      const counts = await assembleSkinCounts(wrappedCols, accountId, save);
      // The in-memory count reflects the intended backfill even though the write itself failed —
      // "best-effort backfill; a failed insert here just means the next read retries it".
      expect(counts.skin_will_fail).toBe(1);
      expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_will_fail' })).toBe(0);
    });
  });

  // ── escrowSkin ─────────────────────────────────────────────────────────────────────────────────
  describe('escrowSkin', () => {
    it('missing skinId/orderId -> BAD_REQUEST', async () => {
      const res = await escrowSkin(m.collections, now, accountId, '', 'order1');
      expect(res).toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('happy path: removes skinId from inventory.skins', async () => {
      await seedSkins(['skin_ink_blue', 'skin_ink_red']);
      const res = await escrowSkin(m.collections, now, accountId, 'skin_ink_blue', 'order1');
      expect(res).toMatchObject({ skinId: 'skin_ink_blue' });
      expect((await readSave()).inventory.skins).toEqual(['skin_ink_red']);
    });

    it('save not found -> NOT_FOUND', async () => {
      const res = await escrowSkin(m.collections, now, 'ghost-account-no-save', 'skin_x', 'order-ghost-acct');
      expect(res).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('not owned -> SKIN_NOT_FOUND', async () => {
      await seedSkins([]);
      const res = await escrowSkin(m.collections, now, accountId, 'skin_ghost', 'order-notowned');
      expect(res).toMatchObject({ code: 'SKIN_NOT_FOUND' });
    });

    it('equipped, only copy -> SKIN_IN_USE', async () => {
      await seedSkins(['skin_ink_blue']);
      await seedEquipped({ notebook: 'skin_ink_blue' });
      const res = await escrowSkin(m.collections, now, accountId, 'skin_ink_blue', 'order-worn');
      expect(res).toMatchObject({ code: 'SKIN_IN_USE' });
    });

    it('equipped but a surplus copy exists -> succeeds, still owned afterward', async () => {
      await seedSkins(['skin_ink_blue']);
      await seedEquipped({ notebook: 'skin_ink_blue' });
      await seedSkinInstances('skin_ink_blue', 2);
      const res = await escrowSkin(m.collections, now, accountId, 'skin_ink_blue', 'order-surplus');
      expect('error' in res).toBe(false);
      expect((await readSave()).inventory.skins).toContain('skin_ink_blue');
      expect(await countSkinInstances(m.collections, accountId, 'skin_ink_blue')).toBe(1);
    });

    it('idempotent: replaying the same orderId at the top short-circuits without side effects', async () => {
      await seedSkins(['skin_ink_blue']);
      const r1 = await escrowSkin(m.collections, now, accountId, 'skin_ink_blue', 'orderX');
      const r2 = await escrowSkin(m.collections, now, accountId, 'skin_ink_blue', 'orderX');
      expect(r2).toEqual(r1);
    });

    it('concurrently-escrowed race: idem doc becomes visible only between the two ownership-path findOnes -> replays', async () => {
      await seedSkins([]); // not owned, from this account's own inventory point of view
      await m.collections.equipmentIdem.insertOne({
        _id: 'order-race', accountId, op: 'skin_escrow', result: { skinId: 'skin_raced' }, expireAt: new Date(Date.now() + 1_000_000),
      });
      const real = m.collections.equipmentIdem;
      let calls = 0;
      const wrapped = {
        findOne: async (q: Record<string, unknown>) => {
          calls++;
          return calls === 1 ? null : real.findOne(q); // top check misses it; inner check (after "not owned") finds it
        },
        updateOne: real.updateOne.bind(real),
      } as typeof real;
      const wrappedCols: Collections = { ...m.collections, equipmentIdem: wrapped };
      const res = await escrowSkin(wrappedCols, now, accountId, 'skin_raced', 'order-race');
      expect(res).toEqual({ skinId: 'skin_raced' });
    });

    it('save disappears mid rev-retry-loop -> falls through to success (escrow itself already committed)', async () => {
      await seedSkins(['skin_ink_blue']);
      const real = m.collections.saves;
      let calls = 0;
      const wrapped = {
        findOne: async (q: Record<string, unknown>) => {
          calls++;
          return calls === 1 ? real.findOne(q) : null; // 1st = doc0 ownership check; 2nd = rev loop
        },
        findOneAndUpdate: real.findOneAndUpdate.bind(real),
        updateOne: real.updateOne.bind(real),
      } as typeof real;
      const wrappedCols: Collections = { ...m.collections, saves: wrapped };
      const res = await escrowSkin(wrappedCols, now, accountId, 'skin_ink_blue', 'order-save-gone');
      expect(res).toEqual({ skinId: 'skin_ink_blue' });
      // The instance delete already committed against the real collection.
      expect(await countSkinInstances(m.collections, accountId, 'skin_ink_blue')).toBe(0);
    });

    it('rev-retries exhausted -> falls through to success (self-healing mirror)', async () => {
      await seedSkins(['skin_ink_blue']);
      const real = m.collections.saves;
      const wrapped = {
        findOne: real.findOne.bind(real),
        findOneAndUpdate: async () => null,
        updateOne: real.updateOne.bind(real),
      } as unknown as typeof real;
      const wrappedCols: Collections = { ...m.collections, saves: wrapped };
      const res = await escrowSkin(wrappedCols, now, accountId, 'skin_ink_blue', 'order-exhaust');
      expect(res).toEqual({ skinId: 'skin_ink_blue' });
    });

    it('reachable via the internal HTTP route too', async () => {
      await seedSkins(['skin_ink_blue']);
      const r = body(await escrowHttp('skin_ink_blue', 'http-order-1'));
      expect(r.ok).toBe(true);
      expect(r.skinId).toBe('skin_ink_blue');
    });
  });

  // ── grantSkin ──────────────────────────────────────────────────────────────────────────────────
  describe('grantSkin', () => {
    it('missing skinId -> BAD_REQUEST', async () => {
      const res = await grantSkin(m.collections, now, accountId, '', 'order1');
      expect(res).toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('happy path: mints a real instance + updates inventory.skins + everOwned.skin', async () => {
      await seedSkins([]);
      const res = await grantSkin(m.collections, now, accountId, 'skin_ink_blue', 'grant-order-1');
      expect(res).toEqual({ ok: true });
      const save = await readSave();
      expect(save.inventory.skins).toContain('skin_ink_blue');
      expect(save.everOwned?.skin).toContain('skin_ink_blue');
      expect(await countSkinInstances(m.collections, accountId, 'skin_ink_blue')).toBe(1);
    });

    it('replaying the same orderId (instance already minted) is a no-op via the `already` short-circuit', async () => {
      await seedSkins([]);
      await grantSkin(m.collections, now, accountId, 'skin_ink_blue', 'grant-dup');
      const revAfterFirst = (await readSave()).rev;
      const res = await grantSkin(m.collections, now, accountId, 'skin_ink_blue', 'grant-dup');
      expect(res).toEqual({ ok: true });
      expect((await readSave()).rev).toBe(revAfterFirst); // no further save write
      expect(await countSkinInstances(m.collections, accountId, 'skin_ink_blue')).toBe(1);
    });

    it('two different orderIds for the same skinId stack two real instances (fungible trade transfer)', async () => {
      await seedSkins([]);
      await grantSkin(m.collections, now, accountId, 'skin_ink_blue', 'trade-1');
      await grantSkin(m.collections, now, accountId, 'skin_ink_blue', 'trade-2');
      const save = await readSave();
      expect(save.inventory.skins.filter((id: string) => id === 'skin_ink_blue')).toHaveLength(1);
      expect(await countSkinInstances(m.collections, accountId, 'skin_ink_blue')).toBe(2);
    });

    it('already in inventory.skins (no matching instance for this exact orderId) -> mints the instance but skips the save write', async () => {
      await seedSkins(['skin_ink_blue']); // legacy-style: owned, but no skinInstances row for this specific grant
      const revBefore = (await readSave()).rev;
      const res = await grantSkin(m.collections, now, accountId, 'skin_ink_blue', 'grant-already-owned');
      expect(res).toEqual({ ok: true });
      expect((await readSave()).rev).toBe(revBefore); // "another instance already present, no save write needed"
      expect(await countSkinInstances(m.collections, accountId, 'skin_ink_blue')).toBe(1);
    });

    it('save not found -> NOT_FOUND', async () => {
      const res = await grantSkin(m.collections, now, 'ghost-account-grant', 'skin_x', 'grant-ghost-acct');
      expect(res).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rev-retries exhausted -> REV_CONFLICT', async () => {
      await seedSkins([]);
      const real = m.collections.saves;
      const wrapped = {
        findOne: real.findOne.bind(real),
        findOneAndUpdate: async () => null,
        updateOne: real.updateOne.bind(real),
      } as unknown as typeof real;
      const wrappedCols: Collections = { ...m.collections, saves: wrapped };
      const res = await grantSkin(wrappedCols, now, accountId, 'skin_fresh', 'grant-exhaust');
      expect(res).toMatchObject({ code: 'REV_CONFLICT' });
      // The instance itself was still minted (unconditional upsert before the save loop).
      expect(await countSkinInstances(m.collections, accountId, 'skin_fresh')).toBe(1);
    });

    it('reachable via the internal HTTP route too', async () => {
      await seedSkins([]);
      const r = body(await grantHttp('skin_ink_blue', 'http-grant-1'));
      expect(r.ok).toBe(true);
      expect((await readSave()).inventory.skins).toContain('skin_ink_blue');
    });
  });

  // ── POST /skins/sell is gone (2026-08-15) ──────────────────────────────────────────────────────
  // The "sell one surplus skin to the system for DUPE_REFUND_COINS" shortcut was removed end-to-end
  // (client button + route + sellSkinToSystem): the duplicate-refund table it reused pays far below a
  // skin's market value, so it only ever destroyed value by accident. A surplus skin's one outlet is
  // the auction house (escrowSkin, above). Guards against the route quietly coming back.
  describe('removed sell-to-system route', () => {
    it('POST /skins/sell is no longer registered -> 404', async () => {
      await seedSkins(['skin_l1']);
      await seedSkinInstances('skin_l1', 2);
      const r = await app.inject({ method: 'POST', url: '/skins/sell', headers: auth(), payload: { skinId: 'skin_l1', idempotencyKey: 'k-gone' } });
      expect(r.statusCode).toBe(404);
      expect(await countSkinInstances(m.collections, accountId, 'skin_l1')).toBe(2);
    });
  });
});
