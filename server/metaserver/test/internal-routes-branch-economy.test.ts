// Branch-coverage backfill for internal/economyRoutes.ts — the shapes internal-economy.test.ts never
// sends. Three families:
//   (a) absent-field fallbacks in the material read path (`doc.save.materials?.[m] ?? 0`) and in the
//       provenance tag (`orderId ?? randomUUID()`, the back-compat caller that supplies no orderId),
//   (b) every refusal / retry-exhaustion mapping worldsvc actually sees: 400/402/404/409, plus the
//       orderId-reservation release that decides whether a caller's retry can ever succeed again,
//   (c) the skin escrow/grant pair, which had no src-level route test at all (only dist-importing e2e).
// Registers the route module from ../src (never ../dist — v8 coverage cannot attribute dist/*.js to src/*.ts).
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { makeNewSave, type Collections, type SaveData } from '@nw/shared';
import { registerEconomyRoutes } from '../src/internal/economyRoutes.js';
import type { InternalCtx } from '../src/internal/context.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeGateway, fakeCommercial, ThrowingSocialsvc } from './helpers/fakeClients.js';
import { AccountCache } from '../src/accountCache.js';

interface SaveDocRow { _id: string; save: SaveData; rev: number }
interface GrantOrderRow { _id: string; accountId: string; kind: string; ts: number; expireAt: Date }
interface SkinInstanceRow { _id: string; accountId: string; skinId: string; sourceType?: string; obtainedAt?: number }
interface IdemRow { _id: string; accountId: string; op: string; result: unknown; expireAt: Date }

const KEY = 'test-internal-key';
const authHeaders = { 'x-internal-key': KEY };

function saveRow(id: string, extra: Partial<SaveData> = {}): SaveDocRow {
  const s = { ...makeNewSave(id, 1000), ...extra };
  return { _id: id, save: s, rev: s.rev };
}

/** saves double whose rev-guarded CAS never matches — models a hot account losing every retry. */
class NeverMatchingSaves extends FakeCollection<SaveDocRow> {
  override async findOneAndUpdate(): Promise<SaveDocRow | null> {
    return null;
  }
}

/** internalGrantOrders double that fails with something other than 11000 (e.g. a dropped connection). */
class BrokenGrantOrders extends FakeCollection<GrantOrderRow> {
  override async insertOne(): Promise<{ insertedId: string }> {
    throw Object.assign(new Error('connection reset by peer'), { code: 6 });
  }
}

function build(opts: {
  saves?: SaveDocRow[];
  skins?: SkinInstanceRow[];
  neverMatchingSaves?: boolean;
  brokenGrantOrders?: boolean;
} = {}) {
  const saves = (opts.neverMatchingSaves ? new NeverMatchingSaves() : new FakeCollection<SaveDocRow>())
    .seed(...(opts.saves ?? []));
  const internalGrantOrders = opts.brokenGrantOrders ? new BrokenGrantOrders() : new FakeCollection<GrantOrderRow>();
  const skinInstances = new FakeCollection<SkinInstanceRow>().seed(...(opts.skins ?? []));
  const cols = {
    saves,
    internalGrantOrders,
    skinInstances,
    equipmentInstances: new FakeCollection<{ _id: string; accountId: string }>(),
    cardInstances: new FakeCollection<{ _id: string; accountId: string }>(),
    cardIdem: new FakeCollection<IdemRow>(),
    equipmentIdem: new FakeCollection<IdemRow>(),
    materialInstances: new FakeCollection<{ _id: string; accountId: string; materialId: string; count: number; sourceType?: string }>(),
  } as unknown as Collections;
  const ctx: InternalCtx = {
    cols,
    now: () => 1000,
    gateway: fakeGateway(),
    commercial: fakeCommercial(),
    socialsvc: new ThrowingSocialsvc(),
    authed: (headers) => headers['x-internal-key'] === KEY,
    redis: null,
    accountCache: new AccountCache(),
  };
  const app = Fastify();
  registerEconomyRoutes(app, ctx);
  return {
    app,
    saves,
    internalGrantOrders,
    skinInstances: cols.skinInstances as unknown as FakeCollection<SkinInstanceRow>,
    materialInstances: cols.materialInstances as unknown as FakeCollection<{ _id: string; accountId: string; materialId: string; count: number; sourceType?: string }>,
  };
}

describe('POST /internal/materials/deduct — absent-balance fallbacks', () => {
  // `doc.save.materials?.[material] ?? 0`: the existing suite always seeds the exact material being
  // deducted, so the "account has never held this material" reading was never taken. worldsvc's auction
  // hits it on every first-ever trade of a material — it must read as 0 and refuse with 402, not NaN.
  it('material key absent from an otherwise present map → 402 insufficient', async () => {
    const { app, saves } = build({ saves: [saveRow('a', { materials: { iron: 99 } } as Partial<SaveData>)] });
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/deduct', headers: authHeaders,
      payload: { accountId: 'a', material: 'wood', qty: 1 },
    });
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'insufficient materials' });
    expect(saves.docs.get('a')!.save.materials).toEqual({ iron: 99 }); // untouched
  });

  it('materials map missing entirely (pre-SLG8 legacy save) → 402, not a crash', async () => {
    const row = saveRow('a');
    delete (row.save as { materials?: unknown }).materials;
    const { app } = build({ saves: [row] });
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/deduct', headers: authHeaders,
      payload: { accountId: 'a', material: 'wood', qty: 1 },
    });
    expect(res.statusCode).toBe(402);
  });
});

describe('POST /internal/materials/deduct — reservation release + retry exhaustion', () => {
  // Save-not-found with an orderId: the reservation must be dropped, otherwise the account's save
  // being created a moment later still leaves every retry of that orderId answered "already deduped".
  it('orderId + unknown save → 404 and the reservation is released', async () => {
    const { app, internalGrantOrders, saves } = build();
    const payload = { accountId: 'ghost', material: 'wood', qty: 1, orderId: 'd-ghost' };
    const r1 = await app.inject({ method: 'POST', url: '/internal/materials/deduct', headers: authHeaders, payload });
    expect(r1.statusCode).toBe(404);
    expect(internalGrantOrders.docs.has('d-ghost')).toBe(false);
    saves.seed(saveRow('ghost', { materials: { wood: 5 } } as Partial<SaveData>));
    const r2 = await app.inject({ method: 'POST', url: '/internal/materials/deduct', headers: authHeaders, payload });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.payload)).toEqual({ ok: true, remaining: 4 });
  });

  // All three rev-guarded attempts lose: worldsvc must be told 409 "retry" (its own retry is safe), and
  // the reservation must be released so that retry is not swallowed as a duplicate.
  it('rev CAS never matches → 409 after 3 attempts, reservation released', async () => {
    const { app, internalGrantOrders } = build({
      saves: [saveRow('a', { materials: { wood: 10 } } as Partial<SaveData>)],
      neverMatchingSaves: true,
    });
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/deduct', headers: authHeaders,
      payload: { accountId: 'a', material: 'wood', qty: 1, orderId: 'd-hot' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'rev conflict, retry' });
    expect(internalGrantOrders.docs.has('d-hot')).toBe(false);
  });

  it('rev CAS never matches without an orderId → still 409 (no reservation to release)', async () => {
    const { app } = build({
      saves: [saveRow('a', { materials: { wood: 10 } } as Partial<SaveData>)],
      neverMatchingSaves: true,
    });
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/deduct', headers: authHeaders,
      payload: { accountId: 'a', material: 'wood', qty: 1 },
    });
    expect(res.statusCode).toBe(409);
  });

  // reserveGrantOrder only swallows duplicate-key (11000); anything else is a real storage failure and
  // must surface as a 500 rather than being mistaken for "this orderId was already processed" (which
  // would answer {ok:true, deduped:true} and silently skip a deduction the caller believes happened).
  it('non-duplicate-key storage error during reservation → 500, never a false "deduped"', async () => {
    const { app, saves } = build({
      saves: [saveRow('a', { materials: { wood: 10 } } as Partial<SaveData>)],
      brokenGrantOrders: true,
    });
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/deduct', headers: authHeaders,
      payload: { accountId: 'a', material: 'wood', qty: 1, orderId: 'd-broken' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.payload).not.toContain('deduped');
    expect((saves.docs.get('a')!.save.materials as Record<string, number>).wood).toBe(10);
  });
});

describe('POST /internal/materials/grant — argument validation', () => {
  // /grant had no 400 test at all, unlike /deduct — an operator/worldsvc bug sending qty as a string or
  // omitting the material would otherwise reach the save-write loop with `undefined` as a map key.
  it.each([
    ['material omitted', { accountId: 'a', qty: 5 }],
    ['accountId omitted', { material: 'wood', qty: 5 }],
    ['qty not a number', { accountId: 'a', material: 'wood', qty: '5' }],
    ['qty zero', { accountId: 'a', material: 'wood', qty: 0 }],
    ['qty negative', { accountId: 'a', material: 'wood', qty: -3 }],
  ])('%s → 400', async (_label, payload) => {
    const { app, saves } = build({ saves: [saveRow('a')] });
    const res = await app.inject({ method: 'POST', url: '/internal/materials/grant', headers: authHeaders, payload });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'accountId + material + qty (>0) required' });
    expect(saves.docs.get('a')!.save.materials).toEqual({});
  });
});

describe('POST /internal/materials/grant — orderId-less back-compat caller', () => {
  // `orderId ?? randomUUID()` + `orderId ? 'internal_grant:<id>' : 'internal_grant'`: the route's doc
  // comment keeps orderId optional for back-compat, but every existing test supplies one, so the
  // fallback provenance tag (the one an ops-console audit would actually see for such a grant) was
  // never written. Also verifies the grant itself is NOT deduped away when no orderId is given.
  it('grant without orderId → succeeds, provenance tagged plain "internal_grant" with a generated id', async () => {
    const { app, saves, materialInstances, internalGrantOrders } = build({ saves: [saveRow('a')] });
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/grant', headers: authHeaders,
      payload: { accountId: 'a', material: 'iron', qty: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, after: 7 });
    expect((saves.docs.get('a')!.save.materials as Record<string, number>).iron).toBe(7);
    expect(internalGrantOrders.docs.size).toBe(0); // nothing reserved — dedup is opt-in via orderId
    const rows = [...materialInstances.docs.values()].filter((d) => d.accountId === 'a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ materialId: 'iron', count: 7, sourceType: 'internal_grant' });
    expect(rows[0]!._id).toBeTruthy(); // keyed by a freshly generated uuid, not by an absent orderId
  });

  it('two orderId-less grants both land (each gets its own generated provenance id)', async () => {
    const { app, saves, materialInstances } = build({ saves: [saveRow('a')] });
    const payload = { accountId: 'a', material: 'iron', qty: 7 };
    await app.inject({ method: 'POST', url: '/internal/materials/grant', headers: authHeaders, payload });
    await app.inject({ method: 'POST', url: '/internal/materials/grant', headers: authHeaders, payload });
    expect((saves.docs.get('a')!.save.materials as Record<string, number>).iron).toBe(14);
    expect([...materialInstances.docs.values()].filter((d) => d.accountId === 'a')).toHaveLength(2);
  });

  it('rev CAS never matches → 409 and the reservation is released for a later retry', async () => {
    const { app, internalGrantOrders } = build({ saves: [saveRow('a')], neverMatchingSaves: true });
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/grant', headers: authHeaders,
      payload: { accountId: 'a', material: 'iron', qty: 7, orderId: 'g-hot' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'rev conflict, retry' });
    expect(internalGrantOrders.docs.has('g-hot')).toBe(false);
  });
});

describe('POST /internal/skins/escrow', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/skins/escrow', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  // orderId is mandatory here (unlike the grant side): escrow is destructive, so auctionsvc must always
  // supply the idempotency key that lets a retry replay instead of deleting a second instance.
  it.each([
    ['skinId omitted', { accountId: 'a', orderId: 'o1' }],
    ['orderId omitted', { accountId: 'a', skinId: 'skin_e1' }],
    ['accountId omitted', { skinId: 'skin_e1', orderId: 'o1' }],
    ['empty body', {}],
  ])('%s → 400', async (_label, payload) => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/skins/escrow', headers: authHeaders, payload });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'accountId + skinId + orderId required' });
  });

  it('unknown save → 404 NOT_FOUND', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/internal/skins/escrow', headers: authHeaders,
      payload: { accountId: 'ghost', skinId: 'skin_e1', orderId: 'o1' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('skin not owned → 404 SKIN_NOT_FOUND', async () => {
    const { app } = build({ saves: [saveRow('a')] });
    const res = await app.inject({
      method: 'POST', url: '/internal/skins/escrow', headers: authHeaders,
      payload: { accountId: 'a', skinId: 'skin_e1', orderId: 'o1' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toMatchObject({ code: 'SKIN_NOT_FOUND', error: 'skin not owned' });
  });

  // The only *conflict* refusal on this endpoint: listing your last copy of a skin you are wearing.
  // 409 (not 404) is what tells the seller's client "unequip it first" rather than "you don't own it".
  it('last remaining copy is equipped → 409 SKIN_IN_USE, instance untouched', async () => {
    const row = saveRow('a');
    row.save.inventory = { skins: ['skin_e1'], items: {} };
    row.save.equipped = { ...row.save.equipped, 'skin:archer': 'skin_e1' };
    const { app, skinInstances } = build({
      saves: [row],
      skins: [{ _id: 'si1', accountId: 'a', skinId: 'skin_e1' }],
    });
    const res = await app.inject({
      method: 'POST', url: '/internal/skins/escrow', headers: authHeaders,
      payload: { accountId: 'a', skinId: 'skin_e1', orderId: 'o1' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toMatchObject({ code: 'SKIN_IN_USE' });
    expect(skinInstances.docs.has('si1')).toBe(true);
  });

  it('owned and not equipped → 200, instance removed and inventory.skins loses the id', async () => {
    const row = saveRow('a');
    row.save.inventory = { skins: ['skin_e1'], items: {} };
    const { app, saves, skinInstances } = build({
      saves: [row],
      skins: [{ _id: 'si1', accountId: 'a', skinId: 'skin_e1' }],
    });
    const res = await app.inject({
      method: 'POST', url: '/internal/skins/escrow', headers: authHeaders,
      payload: { accountId: 'a', skinId: 'skin_e1', orderId: 'o1' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, skinId: 'skin_e1' });
    expect(skinInstances.docs.has('si1')).toBe(false);
    expect(saves.docs.get('a')!.save.inventory!.skins).toEqual([]);
  });

  it('replaying the same orderId returns the first result instead of a second 404', async () => {
    const row = saveRow('a');
    row.save.inventory = { skins: ['skin_e1'], items: {} };
    const { app } = build({ saves: [row], skins: [{ _id: 'si1', accountId: 'a', skinId: 'skin_e1' }] });
    const payload = { accountId: 'a', skinId: 'skin_e1', orderId: 'o1' };
    await app.inject({ method: 'POST', url: '/internal/skins/escrow', headers: authHeaders, payload });
    const res2 = await app.inject({ method: 'POST', url: '/internal/skins/escrow', headers: authHeaders, payload });
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.payload)).toEqual({ ok: true, skinId: 'skin_e1' });
  });
});

describe('POST /internal/skins/grant', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/skins/grant', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  // orderId is optional on the grant side (back-compat), so only accountId + skinId are required here.
  it.each([
    ['skinId omitted', { accountId: 'a' }],
    ['accountId omitted', { skinId: 'skin_e1' }],
    ['empty body', {}],
  ])('%s → 400', async (_label, payload) => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/skins/grant', headers: authHeaders, payload });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ ok: false, error: 'accountId + skinId required' });
  });

  it('happy path: mints an instance and adds the id to inventory.skins + everOwned', async () => {
    const { app, saves, skinInstances } = build({ saves: [saveRow('a')] });
    const res = await app.inject({
      method: 'POST', url: '/internal/skins/grant', headers: authHeaders,
      payload: { accountId: 'a', skinId: 'skin_e1', orderId: 'g1' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    expect(saves.docs.get('a')!.save.inventory!.skins).toEqual(['skin_e1']);
    expect(saves.docs.get('a')!.save.everOwned?.skin).toEqual(['skin_e1']);
    expect([...skinInstances.docs.values()]).toHaveLength(1);
  });

  // Route-level dedup (reserveGrantOrder), distinct from grantSkin's own orderId-derived instance id:
  // a retried delivery answers {ok:true, deduped:true} and never touches the save a second time.
  it('same orderId retried → {ok, deduped:true}, no second instance', async () => {
    const { app, saves, skinInstances } = build({ saves: [saveRow('a')] });
    const payload = { accountId: 'a', skinId: 'skin_e1', orderId: 'g1' };
    await app.inject({ method: 'POST', url: '/internal/skins/grant', headers: authHeaders, payload });
    const revAfterFirst = saves.docs.get('a')!.save.rev;
    const res2 = await app.inject({ method: 'POST', url: '/internal/skins/grant', headers: authHeaders, payload });
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.payload)).toEqual({ ok: true, deduped: true });
    expect([...skinInstances.docs.values()]).toHaveLength(1);
    expect(saves.docs.get('a')!.save.rev).toBe(revAfterFirst);
  });

  // Failure side: the save does not exist, so the delivery could not be completed. auctionsvc must get
  // the mapped 404 *and* have its reservation released, otherwise the retry it schedules once the save
  // exists would be answered "deduped" and the buyer's skin would never arrive.
  it('unknown save → 404 NOT_FOUND and the reservation is released for a retry', async () => {
    const { app, internalGrantOrders, saves } = build();
    const payload = { accountId: 'ghost', skinId: 'skin_e1', orderId: 'g-ghost' };
    const r1 = await app.inject({ method: 'POST', url: '/internal/skins/grant', headers: authHeaders, payload });
    expect(r1.statusCode).toBe(404);
    expect(JSON.parse(r1.payload)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(internalGrantOrders.docs.has('g-ghost')).toBe(false);
  });

  // The retry that released reservation invites now actually delivers (src/skin.ts fixed 2026-09-03).
  // It used to mint the skinInstances row BEFORE discovering the save was missing, so the failed attempt
  // left an orphan instance keyed by the same orderId; the retry short-circuited on that orphan and
  // answered ok:true without ever adding the id to `inventory.skins` — the "do I own at least one" view
  // the equip picker, everOwned and auctionsvc's contract all read. The trade read as delivered while
  // the skin stayed invisible and unequippable forever.
  it('retry after a save-not-found grant delivers the skin into inventory.skins', async () => {
    const { app, saves, skinInstances } = build();
    const payload = { accountId: 'ghost', skinId: 'skin_e1', orderId: 'g-ghost' };
    await app.inject({ method: 'POST', url: '/internal/skins/grant', headers: authHeaders, payload });
    expect([...skinInstances.docs.values()]).toHaveLength(0); // no orphan minted for a save that isn't there
    saves.seed(saveRow('ghost'));
    const r2 = await app.inject({ method: 'POST', url: '/internal/skins/grant', headers: authHeaders, payload });
    expect(r2.statusCode).toBe(200);
    expect(saves.docs.get('ghost')!.save.inventory!.skins).toEqual(['skin_e1']);
    expect(saves.docs.get('ghost')!.save.everOwned?.skin).toEqual(['skin_e1']);
    expect([...skinInstances.docs.values()]).toHaveLength(1);
  });

  // The orphan-healing half of the same fix: an instance row left behind by a pre-fix grant (or by a
  // crash between the mint and the save write) must not make a retry a silent no-op — the retry has to
  // reconcile inventory.skins, which is why grantSkin no longer returns early on an existing instance.
  it('an orphan instance row from a pre-fix grant is healed by the retry rather than short-circuiting it', async () => {
    const { app, saves, skinInstances } = build({ saves: [saveRow('a')] });
    skinInstances.seed({ _id: 'skin_grant_g-orphan', accountId: 'a', skinId: 'skin_e1' });
    const r = await app.inject({
      method: 'POST', url: '/internal/skins/grant', headers: authHeaders,
      payload: { accountId: 'a', skinId: 'skin_e1', orderId: 'g-orphan' },
    });
    expect(r.statusCode).toBe(200);
    expect(saves.docs.get('a')!.save.inventory!.skins).toEqual(['skin_e1']);
    expect([...skinInstances.docs.values()]).toHaveLength(1); // healed, not duplicated
  });

  it('the save disappears between the existence pre-check and the loop read → 404, reservation released', async () => {
    // grantSkin reads saves twice: once to refuse a missing save before minting anything, then again
    // inside the rev loop. A delete landing in that window is the only way to reach the loop's own
    // not-found arm, and it must answer 404 (releasing the reservation for a retry) rather than
    // reporting a delivery that never happened.
    const { app, internalGrantOrders, saves } = build({ saves: [saveRow('a')] });
    let reads = 0;
    const real = saves.findOne.bind(saves);
    saves.findOne = async (q?: Record<string, unknown>) => (++reads === 1 ? real(q) : null);
    const r = await app.inject({
      method: 'POST', url: '/internal/skins/grant', headers: authHeaders,
      payload: { accountId: 'a', skinId: 'skin_e1', orderId: 'g-vanish' },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(internalGrantOrders.docs.has('g-vanish')).toBe(false);
  });

  it('rev CAS never matches → 409 REV_CONFLICT, reservation released', async () => {
    const { app, internalGrantOrders } = build({ saves: [saveRow('a')], neverMatchingSaves: true });
    const res = await app.inject({
      method: 'POST', url: '/internal/skins/grant', headers: authHeaders,
      payload: { accountId: 'a', skinId: 'skin_e1', orderId: 'g-hot' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toMatchObject({ code: 'REV_CONFLICT' });
    expect(internalGrantOrders.docs.has('g-hot')).toBe(false);
  });
});
