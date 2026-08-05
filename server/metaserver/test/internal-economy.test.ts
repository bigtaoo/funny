// Route-level tests for internal/economyRoutes.ts (split out of internal.ts):
//   materials {deduct,grant}, cards {escrow,grant}, save-fields.
// (equipment escrow/grant already covered end-to-end by equipment.e2e.test.ts and is not repeated here.)
// Uses Fastify inject + in-memory fake cols (no Mongo) — same style as internal.test.ts.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { makeNewSave, type Collections, type SaveData, type CardInstance } from '@nw/shared';
import { registerEconomyRoutes } from '../src/internal/economyRoutes.js';
import type { InternalCtx } from '../src/internal/context.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeGateway, fakeCommercial, ThrowingSocialsvc } from './helpers/fakeClients.js';

interface SaveDocRow { _id: string; save: SaveData; rev: number }

const KEY = 'test-internal-key';
const authHeaders = { 'x-internal-key': KEY };

function saveRow(id: string, extra: Partial<SaveData> = {}): SaveDocRow {
  const s = { ...makeNewSave(id, 1000), ...extra };
  return { _id: id, save: s, rev: s.rev };
}

interface CardInstanceRow { _id: string; accountId: string; defId: string; level: number; gear: Record<string, string>; locked: boolean }

interface GrantOrderRow { _id: string; accountId: string; kind: string; ts: number; expireAt: Date }

function build(seedSaves: SaveDocRow[] = [], seedCards: CardInstanceRow[] = []) {
  const saves = new FakeCollection<SaveDocRow>().seed(...seedSaves);
  const equipmentInstances = new FakeCollection<{ _id: string; accountId: string }>();
  const cardInstances = new FakeCollection<CardInstanceRow>().seed(...seedCards);
  const internalGrantOrders = new FakeCollection<GrantOrderRow>();
  const cardIdem = new FakeCollection<{ _id: string; accountId: string; op: string; result: unknown; expireAt: Date }>();
  const cols = { saves, equipmentInstances, cardInstances, internalGrantOrders, cardIdem } as unknown as Collections;
  const ctx: InternalCtx = {
    cols,
    now: () => 1000,
    gateway: fakeGateway(),
    commercial: fakeCommercial(),
    socialsvc: new ThrowingSocialsvc(),
    authed: (headers) => headers['x-internal-key'] === KEY,
  };
  const app = Fastify();
  registerEconomyRoutes(app, ctx);
  return { app, saves, cardInstances, internalGrantOrders, cardIdem };
}

function card(id: string, extra: Partial<CardInstance> = {}): CardInstance {
  return { id, defId: 'lichuang', level: 1, gear: {}, locked: false, ...extra };
}

/** Card instance seeded directly into the `cardInstances` fake collection (bypasses the API). */
function cardRow(id: string, accountId: string, extra: Partial<CardInstance> = {}): CardInstanceRow {
  const c = card(id, extra);
  return { _id: c.id, accountId, defId: c.defId, level: c.level, gear: c.gear, locked: c.locked };
}

describe('POST /internal/materials/deduct', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/materials/deduct', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('missing params → 400', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/materials/deduct', headers: authHeaders, payload: { accountId: 'a' } });
    expect(res.statusCode).toBe(400);
  });

  it('save not found → 404', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/deduct', headers: authHeaders,
      payload: { accountId: 'ghost', material: 'wood', qty: 5 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('insufficient balance → 402', async () => {
    const { app } = build([saveRow('a', { materials: { wood: 3 } } as Partial<SaveData>)]);
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/deduct', headers: authHeaders,
      payload: { accountId: 'a', material: 'wood', qty: 5 },
    });
    expect(res.statusCode).toBe(402);
  });

  it('sufficient balance → deducts and returns remaining', async () => {
    const { app, saves } = build([saveRow('a', { materials: { wood: 10 } } as Partial<SaveData>)]);
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/deduct', headers: authHeaders,
      payload: { accountId: 'a', material: 'wood', qty: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, remaining: 6 });
    expect((saves.docs.get('a')!.save.materials as Record<string, number>).wood).toBe(6);
  });

  // 2026-08-03 fix: orderId was documented but previously unused here (unlike /internal/materials/grant),
  // so a caller retry after a timeout could deduct the same material twice for one logical transaction.
  it('regression (2026-08-03 fix): same orderId retried after success → deduped, no double-deduct', async () => {
    const { app, saves } = build([saveRow('a', { materials: { wood: 10 } } as Partial<SaveData>)]);
    const payload = { accountId: 'a', material: 'wood', qty: 4, orderId: 'dup-deduct-1' };
    const r1 = await app.inject({ method: 'POST', url: '/internal/materials/deduct', headers: authHeaders, payload });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'POST', url: '/internal/materials/deduct', headers: authHeaders, payload });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.payload)).toEqual({ ok: true, deduped: true });
    expect((saves.docs.get('a')!.save.materials as Record<string, number>).wood).toBe(6); // not 2
  });

  it('regression (2026-08-03 fix): different orderId → deducts twice', async () => {
    const { app, saves } = build([saveRow('a', { materials: { wood: 10 } } as Partial<SaveData>)]);
    await app.inject({ method: 'POST', url: '/internal/materials/deduct', headers: authHeaders, payload: { accountId: 'a', material: 'wood', qty: 4, orderId: 'd-a' } });
    await app.inject({ method: 'POST', url: '/internal/materials/deduct', headers: authHeaders, payload: { accountId: 'a', material: 'wood', qty: 4, orderId: 'd-b' } });
    expect((saves.docs.get('a')!.save.materials as Record<string, number>).wood).toBe(2);
  });

  it('regression (2026-08-03 fix): orderId reservation is released after insufficient balance, so a later retry can go through', async () => {
    const { app, saves } = build([saveRow('a', { materials: { wood: 3 } } as Partial<SaveData>)]);
    const payload = { accountId: 'a', material: 'wood', qty: 5, orderId: 'd-fail' };
    const r1 = await app.inject({ method: 'POST', url: '/internal/materials/deduct', headers: authHeaders, payload });
    expect(r1.statusCode).toBe(402);
    // Top up, then retry with the same orderId — must not be treated as already-deduped.
    (saves.docs.get('a')!.save.materials as Record<string, number>).wood = 10;
    const r2 = await app.inject({ method: 'POST', url: '/internal/materials/deduct', headers: authHeaders, payload });
    expect(r2.statusCode).toBe(200);
  });
});

describe('POST /internal/materials/grant', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/materials/grant', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('save not found → 404', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/grant', headers: authHeaders,
      payload: { accountId: 'ghost', material: 'wood', qty: 5 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('grants onto an existing balance (creates the material key if absent)', async () => {
    const { app, saves } = build([saveRow('a')]);
    const res = await app.inject({
      method: 'POST', url: '/internal/materials/grant', headers: authHeaders,
      payload: { accountId: 'a', material: 'iron', qty: 7, orderId: 'o1' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, after: 7 });
    expect((saves.docs.get('a')!.save.materials as Record<string, number>).iron).toBe(7);
  });

  // comm-audit-internal-2026-07-28 batch D: orderId dedup (a caller retry after a timeout must not double-grant).
  it('same orderId retried after success → deduped, no double-grant', async () => {
    const { app, saves } = build([saveRow('a')]);
    const payload = { accountId: 'a', material: 'iron', qty: 7, orderId: 'dup-1' };
    const r1 = await app.inject({ method: 'POST', url: '/internal/materials/grant', headers: authHeaders, payload });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'POST', url: '/internal/materials/grant', headers: authHeaders, payload });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.payload)).toEqual({ ok: true, deduped: true });
    expect((saves.docs.get('a')!.save.materials as Record<string, number>).iron).toBe(7); // not 14
  });

  it('different orderId → grants twice', async () => {
    const { app, saves } = build([saveRow('a')]);
    await app.inject({ method: 'POST', url: '/internal/materials/grant', headers: authHeaders, payload: { accountId: 'a', material: 'iron', qty: 7, orderId: 'o-a' } });
    await app.inject({ method: 'POST', url: '/internal/materials/grant', headers: authHeaders, payload: { accountId: 'a', material: 'iron', qty: 7, orderId: 'o-b' } });
    expect((saves.docs.get('a')!.save.materials as Record<string, number>).iron).toBe(14);
  });

  it('orderId reservation is released after a failed grant, so a retry can go through', async () => {
    const { app, saves, internalGrantOrders } = build([]); // no 'ghost' save → grant 404s
    const payload = { accountId: 'ghost', material: 'iron', qty: 7, orderId: 'o-fail' };
    const r1 = await app.inject({ method: 'POST', url: '/internal/materials/grant', headers: authHeaders, payload });
    expect(r1.statusCode).toBe(404);
    expect(internalGrantOrders.docs.has('o-fail')).toBe(false); // reservation released
    saves.seed(saveRow('ghost'));
    const r2 = await app.inject({ method: 'POST', url: '/internal/materials/grant', headers: authHeaders, payload });
    expect(r2.statusCode).toBe(200); // retry with the same orderId succeeds, not deduped-away
  });
});

describe('POST /internal/cards/escrow', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/cards/escrow', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('missing params → 400', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/cards/escrow', headers: authHeaders, payload: { accountId: 'a' } });
    expect(res.statusCode).toBe(400);
  });

  it('save not found → 404 NOT_FOUND', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/internal/cards/escrow', headers: authHeaders,
      payload: { accountId: 'ghost', instanceId: 'c1', orderId: 'o1' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).code).toBe('NOT_FOUND');
  });

  it('card not found → 404 CARD_NOT_FOUND', async () => {
    const { app } = build([saveRow('a')]);
    const res = await app.inject({
      method: 'POST', url: '/internal/cards/escrow', headers: authHeaders,
      payload: { accountId: 'a', instanceId: 'no-such', orderId: 'o1' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).code).toBe('CARD_NOT_FOUND');
  });

  it('card with equipped gear → 409 CARD_HAS_GEAR (§11 rule: unequip before listing)', async () => {
    const { app } = build([saveRow('a')], [cardRow('c1', 'a', { gear: { weapon: 'eq1' } })]);
    const res = await app.inject({
      method: 'POST', url: '/internal/cards/escrow', headers: authHeaders,
      payload: { accountId: 'a', instanceId: 'c1', orderId: 'o1' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).code).toBe('CARD_HAS_GEAR');
  });

  it('happy path: removes card from cardInstances, returns its snapshot', async () => {
    const { app, cardInstances } = build([saveRow('a')], [cardRow('c1', 'a')]);
    const res = await app.inject({
      method: 'POST', url: '/internal/cards/escrow', headers: authHeaders,
      payload: { accountId: 'a', instanceId: 'c1', orderId: 'o1' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.instance).toMatchObject({ id: 'c1', defId: 'lichuang' });
    expect(cardInstances.docs.has('c1')).toBe(false);
  });

  it('regression (2026-08-03 fix): a retry with the same orderId after success replays the snapshot instead of 404 CARD_NOT_FOUND', async () => {
    // Root cause: escrowCard had no idempotency ledger — the card was deleted before any record of the
    // orderId was kept, so a caller retry after a lost response (the instance already gone) hit
    // CARD_NOT_FOUND and never completed the auction listing, permanently losing the card.
    const { app, cardIdem } = build([saveRow('a')], [cardRow('c1', 'a')]);
    const first = await app.inject({
      method: 'POST', url: '/internal/cards/escrow', headers: authHeaders,
      payload: { accountId: 'a', instanceId: 'c1', orderId: 'o1' },
    });
    expect(first.statusCode).toBe(200);
    expect(cardIdem.docs.has('o1')).toBe(true); // ledger entry recorded after success

    const retry = await app.inject({
      method: 'POST', url: '/internal/cards/escrow', headers: authHeaders,
      payload: { accountId: 'a', instanceId: 'c1', orderId: 'o1' },
    });
    expect(retry.statusCode).toBe(200); // not 404 — replays the recorded snapshot
    expect(JSON.parse(retry.payload).instance).toEqual(JSON.parse(first.payload).instance);
  });

  it('regression: escrowCard exhausting rev retries still reports the escrow as done, not REV_CONFLICT with the card gone', async () => {
    // Root cause: escrowCard deleted the card unconditionally up front, then only recorded the escrow
    // ledger entry INSIDE the successful branch of the save-count-decrement retry loop — so exhausting all
    // retries used to return REV_CONFLICT while the card was already deleted with no escrow record
    // anywhere, permanently destroying it with zero compensation. Force every findOneAndUpdate on `saves`
    // to "lose" (simulating contention from an unrelated concurrent save write) to reproduce deterministically.
    const cardInstances = new FakeCollection<CardInstanceRow>().seed(cardRow('c1', 'a'));
    const cardIdem = new FakeCollection<{ _id: string; accountId: string; op: string; result: unknown; committed?: boolean; expireAt: Date }>();
    const realSaves = new FakeCollection<SaveDocRow>().seed(saveRow('a'));
    const saves = {
      findOne: realSaves.findOne.bind(realSaves),
      findOneAndUpdate: async () => null,
    } as unknown as typeof realSaves;
    const cols = { saves, equipmentInstances: new FakeCollection(), cardInstances, cardIdem } as unknown as Collections;
    const ctx: InternalCtx = {
      cols, now: () => 1000, gateway: fakeGateway(), commercial: fakeCommercial(),
      socialsvc: new ThrowingSocialsvc(), authed: (headers) => headers['x-internal-key'] === KEY,
    };
    const app = Fastify();
    registerEconomyRoutes(app, ctx);

    const res = await app.inject({
      method: 'POST', url: '/internal/cards/escrow', headers: authHeaders,
      payload: { accountId: 'a', instanceId: 'c1', orderId: 'o-exhaust' },
    });
    expect(res.statusCode).toBe(200); // not REV_CONFLICT
    expect(cardInstances.docs.has('c1')).toBe(false); // still correctly removed
    expect(cardIdem.docs.has('o-exhaust')).toBe(true); // ledger recorded so a real replay works

    const retry = await app.inject({
      method: 'POST', url: '/internal/cards/escrow', headers: authHeaders,
      payload: { accountId: 'a', instanceId: 'c1', orderId: 'o-exhaust' },
    });
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(retry.payload).instance).toEqual(JSON.parse(res.payload).instance);
  });
});

describe('POST /internal/cards/grant', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/internal/cards/grant', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('missing instance → 400', async () => {
    const { app } = build([saveRow('a')]);
    const res = await app.inject({ method: 'POST', url: '/internal/cards/grant', headers: authHeaders, payload: { accountId: 'a' } });
    expect(res.statusCode).toBe(400);
  });

  it('save not found → 404', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'POST', url: '/internal/cards/grant', headers: authHeaders,
      payload: { accountId: 'ghost', instance: card('c1'), orderId: 'o1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('happy path: writes the instance snapshot into cardInstances (idempotent overwrite by id)', async () => {
    const { app, cardInstances, saves } = build([saveRow('a')]);
    const res = await app.inject({
      method: 'POST', url: '/internal/cards/grant', headers: authHeaders,
      payload: { accountId: 'a', instance: card('c1', { level: 3 }), orderId: 'o1' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    expect(cardInstances.docs.get('c1')).toMatchObject({ _id: 'c1', level: 3 });
    const countAfterFirst = saves.docs.get('a')!.save.cardInvCount;

    // Replay the exact same grant (same instance id/orderId) — grantCard's dedup guard (cards.ts's
    // `already` findOne before the count-increment loop) must skip the cardInvCount++ on this second
    // call. Without this second POST, that guard is never actually exercised.
    const res2 = await app.inject({
      method: 'POST', url: '/internal/cards/grant', headers: authHeaders,
      payload: { accountId: 'a', instance: card('c1', { level: 3 }), orderId: 'o1' },
    });
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.payload)).toEqual({ ok: true, deduped: true });
    expect(saves.docs.get('a')!.save.cardInvCount).toBe(countAfterFirst);
  });
});

describe('GET /internal/save-fields', () => {
  it('no key → 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/save-fields?accountId=a' });
    expect(res.statusCode).toBe(401);
  });

  it('missing accountId → 400', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/save-fields', headers: authHeaders });
    expect(res.statusCode).toBe(400);
  });

  it('unknown account → empty defaults, not 404 (must not freeze a march, E8)', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/internal/save-fields?accountId=ghost', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ cardInv: {}, equipmentInv: {} });
  });

  it('existing account → returns cardInv/equipmentInv snapshot (pveUpgrades dropped from the wire, comm-audit batch F item 6 — the siege engine never read it)', async () => {
    const { app } = build(
      [saveRow('a', { pveUpgrades: { atk: 3 } } as Partial<SaveData>)],
      [cardRow('c1', 'a')],
    );
    const res = await app.inject({ method: 'GET', url: '/internal/save-fields?accountId=a', headers: authHeaders });
    const body = JSON.parse(res.payload);
    expect(body.pveUpgrades).toBeUndefined();
    expect(Object.keys(body.cardInv)).toEqual(['c1']);
  });

  it('fields=cardInv → only cardInv is returned (batch F item 6 projection narrowing)', async () => {
    const { app } = build(
      [saveRow('a', {} as Partial<SaveData>)],
      [cardRow('c1', 'a')],
    );
    const res = await app.inject({ method: 'GET', url: '/internal/save-fields?accountId=a&fields=cardInv', headers: authHeaders });
    const body = JSON.parse(res.payload);
    expect(Object.keys(body.cardInv)).toEqual(['c1']);
    expect(body.equipmentInv).toBeUndefined();
  });

  it('fields=equipmentInv → only equipmentInv is returned', async () => {
    const { app } = build([saveRow('a', {} as Partial<SaveData>)], [cardRow('c1', 'a')]);
    const res = await app.inject({ method: 'GET', url: '/internal/save-fields?accountId=a&fields=equipmentInv', headers: authHeaders });
    const body = JSON.parse(res.payload);
    expect(body.cardInv).toBeUndefined();
    expect(body.equipmentInv).toEqual({});
  });

  // cardIds narrowing (2026-08-02): worldsvc's getTeams self-heal only needs to know whether the ids
  // its formations reference still resolve — reassembling the player's whole roster for that was the
  // dominant cost of GET /world/teams, which sits on the CityScene critical path.
  it('cardIds=… → cardInv is narrowed to just those instance ids', async () => {
    const { app } = build(
      [saveRow('a', {} as Partial<SaveData>)],
      [cardRow('c1', 'a'), cardRow('c2', 'a'), cardRow('c3', 'a')],
    );
    const res = await app.inject({ method: 'GET', url: '/internal/save-fields?accountId=a&fields=cardInv&cardIds=c1,c3', headers: authHeaders });
    expect(Object.keys(JSON.parse(res.payload).cardInv).sort()).toEqual(['c1', 'c3']);
  });

  it('cardIds stays account-scoped — another account\'s instance id does not leak', async () => {
    const { app } = build(
      [saveRow('a', {} as Partial<SaveData>)],
      [cardRow('c1', 'a'), cardRow('other', 'b')],
    );
    const res = await app.inject({ method: 'GET', url: '/internal/save-fields?accountId=a&fields=cardInv&cardIds=c1,other', headers: authHeaders });
    expect(Object.keys(JSON.parse(res.payload).cardInv)).toEqual(['c1']);
  });

  it('no cardIds → still the full roster (existing siege-engine callers are unaffected)', async () => {
    const { app } = build(
      [saveRow('a', {} as Partial<SaveData>)],
      [cardRow('c1', 'a'), cardRow('c2', 'a')],
    );
    const res = await app.inject({ method: 'GET', url: '/internal/save-fields?accountId=a&fields=cardInv', headers: authHeaders });
    expect(Object.keys(JSON.parse(res.payload).cardInv).sort()).toEqual(['c1', 'c2']);
  });
});
