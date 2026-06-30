// L2-2: Title endpoints (GET /titles, PUT /title/equip) unit tests, no Mongo.
// Uses buildApp with full openapi glue (also verifies that new operationIds are bound to handlers; throws at registration if missing),
// driven by in-memory fake cols + fastify inject.
import { describe, it, expect } from 'vitest';
import { makeNewSave, signToken, ladderTitleId, type Collections, type SaveData } from '@nw/shared';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const jwt = { secret: 'test-secret' };

function getDotted(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}
function setDotted(obj: Record<string, unknown>, path: string, val: unknown): void {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]!] == null) o[keys[i]!] = {};
    o = o[keys[i]!] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]!] = val;
}

class FakeCol {
  docs = new Map<string, Record<string, unknown>>();
  async findOne(q: Record<string, unknown>) {
    return typeof q._id === 'string' ? this.docs.get(q._id) ?? null : null;
  }
  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
    opts?: { upsert?: boolean },
  ) {
    let d = typeof filter._id === 'string' ? this.docs.get(filter._id) : undefined;
    const existed = !!d;
    if (!d) {
      if (!opts?.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      d = { _id: filter._id };
      this.docs.set(filter._id as string, d);
    }
    if (update.$setOnInsert && !existed) Object.assign(d, update.$setOnInsert);
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) setDotted(d, k, v);
    return { matchedCount: existed ? 1 : 0, modifiedCount: 1, upsertedCount: existed ? 0 : 1 };
  }
  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
    opts?: { returnDocument?: 'before' | 'after' },
  ) {
    const d = typeof filter._id === 'string' ? this.docs.get(filter._id) : undefined;
    if (!d || (filter.rev !== undefined && d.rev !== filter.rev)) return null;
    const before = { ...d };
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) setDotted(d, k, v);
    return opts?.returnDocument === 'before' ? before : d;
  }
}

function fakeCols(seed?: { accountId: string; mutate?: (s: SaveData) => void }): Collections {
  const saves = new FakeCol();
  if (seed) {
    const s = makeNewSave(seed.accountId, 1000);
    seed.mutate?.(s);
    saves.docs.set(seed.accountId, { _id: seed.accountId, save: s, rev: s.rev });
  }
  return { saves } as unknown as Collections;
}

async function makeApp(cols: Collections): Promise<FastifyInstance> {
  return buildApp({ cols, jwt, internalKey: 'k', commercialUrl: null, gatewayUrl: null, authRateLimit: 0 });
}

const ACC = 'acc-1';
const auth = { authorization: `Bearer ${signToken(ACC, jwt)}` };

describe('GET /titles (L2-2)', () => {
  it('returns granted titles (including derived source/seasonNo) + currently equipped', async () => {
    const cols = fakeCols({
      accountId: ACC,
      mutate: (s) => {
        s.titles = [ladderTitleId(3, 'gold'), 'event.founder'];
        s.equipped = { title: 'event.founder' };
      },
    });
    const app = await makeApp(cols);
    const res = await app.inject({ method: 'GET', url: '/titles', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.equipped).toBe('event.founder');
    expect(body.data.titles).toEqual([
      { id: 'ladder.s3.gold', source: 'ladder', seasonNo: 3 },
      { id: 'event.founder', source: 'event' },
    ]);
    await app.close();
  });

  it('new account with no titles → empty array + equipped:null', async () => {
    const app = await makeApp(fakeCols());
    const res = await app.inject({ method: 'GET', url: '/titles', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ titles: [], equipped: null });
    await app.close();
  });
});

describe('PUT /title/equip (L2-2)', () => {
  it('equip a granted title → writes equipped.title and returns it', async () => {
    const cols = fakeCols({ accountId: ACC, mutate: (s) => { s.titles = [ladderTitleId(3, 'gold')]; } });
    const app = await makeApp(cols);
    const res = await app.inject({
      method: 'PUT',
      url: '/title/equip',
      headers: auth,
      payload: { titleId: 'ladder.s3.gold' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.save.equipped.title).toBe('ladder.s3.gold');
    await app.close();
  });

  it('equip a title not yet granted → 403', async () => {
    const cols = fakeCols({ accountId: ACC, mutate: (s) => { s.titles = []; } });
    const app = await makeApp(cols);
    const res = await app.inject({
      method: 'PUT',
      url: '/title/equip',
      headers: auth,
      payload: { titleId: 'ladder.s9.king' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().ok).toBe(false);
    await app.close();
  });

  it('empty titleId → unequip the displayed title', async () => {
    const cols = fakeCols({
      accountId: ACC,
      mutate: (s) => { s.titles = ['event.founder']; s.equipped = { title: 'event.founder' }; },
    });
    const app = await makeApp(cols);
    const res = await app.inject({
      method: 'PUT',
      url: '/title/equip',
      headers: auth,
      payload: { titleId: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.save.equipped.title).toBeUndefined();
    await app.close();
  });
});
