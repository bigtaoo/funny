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

function build(seedSaves: SaveDocRow[] = []) {
  const saves = new FakeCollection<SaveDocRow>().seed(...seedSaves);
  const cols = { saves } as unknown as Collections;
  const ctx: InternalCtx = {
    cols,
    now: () => 1000,
    gateway: fakeGateway(),
    commercial: fakeCommercial(),
    socialsvc: new ThrowingSocialsvc(),
    authed: (key) => key === KEY,
  };
  const app = Fastify();
  registerEconomyRoutes(app, ctx);
  return { app, saves };
}

function card(id: string, extra: Partial<CardInstance> = {}): CardInstance {
  return { id, defId: 'lichuang', level: 1, xp: 0, gear: {}, locked: false, ...extra };
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
    const { app } = build([saveRow('a', { cardInv: { c1: card('c1', { gear: { weapon: 'eq1' } }) } } as Partial<SaveData>)]);
    const res = await app.inject({
      method: 'POST', url: '/internal/cards/escrow', headers: authHeaders,
      payload: { accountId: 'a', instanceId: 'c1', orderId: 'o1' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).code).toBe('CARD_HAS_GEAR');
  });

  it('happy path: removes card from cardInv, returns its snapshot', async () => {
    const inst = card('c1');
    const { app, saves } = build([saveRow('a', { cardInv: { c1: inst } } as Partial<SaveData>)]);
    const res = await app.inject({
      method: 'POST', url: '/internal/cards/escrow', headers: authHeaders,
      payload: { accountId: 'a', instanceId: 'c1', orderId: 'o1' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.instance).toMatchObject({ id: 'c1', defId: 'lichuang' });
    expect(saves.docs.get('a')!.save.cardInv).toEqual({});
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

  it('happy path: writes the instance snapshot into cardInv (idempotent overwrite by id)', async () => {
    const { app, saves } = build([saveRow('a')]);
    const res = await app.inject({
      method: 'POST', url: '/internal/cards/grant', headers: authHeaders,
      payload: { accountId: 'a', instance: card('c1', { level: 3 }), orderId: 'o1' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    expect((saves.docs.get('a')!.save.cardInv as Record<string, CardInstance>).c1).toMatchObject({ id: 'c1', level: 3 });
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
    expect(JSON.parse(res.payload)).toEqual({ pveUpgrades: {}, cardInv: {}, equipmentInv: {} });
  });

  it('existing account → returns pveUpgrades/cardInv/equipmentInv snapshot', async () => {
    const { app } = build([saveRow('a', {
      pveUpgrades: { atk: 3 },
      cardInv: { c1: card('c1') },
      equipmentInv: {},
    } as Partial<SaveData>)]);
    const res = await app.inject({ method: 'GET', url: '/internal/save-fields?accountId=a', headers: authHeaders });
    const body = JSON.parse(res.payload);
    expect(body.pveUpgrades).toEqual({ atk: 3 });
    expect(Object.keys(body.cardInv)).toEqual(['c1']);
  });
});
