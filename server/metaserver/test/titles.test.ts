// L2-2: Title endpoints (GET /titles, PUT /title/equip) unit tests, no Mongo.
// Uses buildApp with full openapi glue (also verifies that new operationIds are bound to handlers; throws at registration if missing),
// driven by in-memory fake cols + fastify inject.
import { describe, it, expect } from 'vitest';
import { makeNewSave, signToken, ladderTitleId, type Collections, type SaveData } from '@nw/shared';
import { buildApp } from '../src/app.js';
import { grantTitleToPlayer } from '../src/titles.js';
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

  it('new account → starts with the newbie starter title, auto-equipped', async () => {
    // makeNewSave seeds event.newbie (TITLE_DESIGN §6); getOrCreateSave persists it for a fresh account.
    const app = await makeApp(fakeCols());
    const res = await app.inject({ method: 'GET', url: '/titles', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      // ITEM_IDENTITY_DESIGN.md task3 (2026-08-10): makeNewSave also stamps titleGrants['event.newbie'],
      // so the starter title now round-trips with an obtainedAt (real Date.now(), hence expect.any).
      titles: [{ id: 'event.newbie', source: 'event', obtainedAt: expect.any(Number) }],
      equipped: 'event.newbie',
    });
    await app.close();
  });

  it('titleGrants records the obtainedAt timestamp for a directly-seeded title (task3)', async () => {
    const cols = fakeCols({
      accountId: ACC,
      mutate: (s) => {
        s.titles = ['event.founder'];
        s.titleGrants = { 'event.founder': 12345 };
        s.equipped = { title: 'event.founder' };
      },
    });
    const app = await makeApp(cols);
    const res = await app.inject({ method: 'GET', url: '/titles', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.titles).toEqual([{ id: 'event.founder', source: 'event', obtainedAt: 12345 }]);
    await app.close();
  });

  it('a title with no titleGrants entry (legacy account) omits obtainedAt', async () => {
    const cols = fakeCols({
      accountId: ACC,
      mutate: (s) => {
        s.titles = ['event.founder'];
        s.titleGrants = undefined; // simulate a pre-task3 save
        s.equipped = { title: 'event.founder' };
      },
    });
    const app = await makeApp(cols);
    const res = await app.inject({ method: 'GET', url: '/titles', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.titles).toEqual([{ id: 'event.founder', source: 'event' }]);
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

// grantTitleToPlayer unit coverage (ITEM_IDENTITY_DESIGN.md task3 follow-up, 2026-08-10): the genuine
// concurrent-write race (two different titleIds granted at once) needs real Mongo to reproduce honestly —
// see starter-title.e2e.test.ts's 'two different titleIds granted concurrently' test — because this
// file's FakeCol.findOne returns a live reference into its Map rather than a snapshot copy, so two
// same-tick reads here would alias the same mutable object and never observe genuine staleness the way
// a real document read does. What IS safe to test without Mongo: purely sequential multi-grant
// accumulation (no interleaving at all), and forcing rev-conflict exhaustion with a fake collection whose
// findOneAndUpdate always refuses (deterministic, cannot be reproduced reliably by hammering real Mongo
// with exactly 4 competing writes).
describe('grantTitleToPlayer (unit, no Mongo)', () => {
  it('sequential grants of different titles to the same account accumulate in titleGrants without overwriting earlier entries', async () => {
    const cols = fakeCols({ accountId: ACC });
    await grantTitleToPlayer(cols, ACC, 'ach.one', 1000);
    await grantTitleToPlayer(cols, ACC, 'ach.two', 2000);
    await grantTitleToPlayer(cols, ACC, 'ach.three', 3000);

    const row = (cols.saves as unknown as { docs: Map<string, { save: SaveData }> }).docs.get(ACC)!;
    expect(row.save.titles).toEqual(expect.arrayContaining(['event.newbie', 'ach.one', 'ach.two', 'ach.three']));
    expect(row.save.titleGrants).toMatchObject({ 'ach.one': 1000, 'ach.two': 2000, 'ach.three': 3000 });
  });

  it('re-granting the same title again after other titles landed still keeps the original obtainedAt (idempotent, does not disturb the accumulated batch)', async () => {
    const cols = fakeCols({ accountId: ACC });
    await grantTitleToPlayer(cols, ACC, 'ach.one', 1000);
    await grantTitleToPlayer(cols, ACC, 'ach.two', 2000);
    await grantTitleToPlayer(cols, ACC, 'ach.one', 9999); // re-grant, must be a no-op

    const row = (cols.saves as unknown as { docs: Map<string, { save: SaveData }> }).docs.get(ACC)!;
    expect(row.save.titles.filter((t) => t === 'ach.one')).toHaveLength(1);
    expect(row.save.titleGrants).toMatchObject({ 'ach.one': 1000, 'ach.two': 2000 });
  });

  it('rev conflict exhausted across all 4 attempts: the title is silently not granted, but grantTitleToPlayer still resolves without throwing (known limitation — no error surfaces to the caller)', async () => {
    // A hand-rolled fake (not the shared FakeCol above) whose findOneAndUpdate always refuses, simulating
    // an opponent that wins the rev race on every single attempt — the one scenario that's impractical to
    // force reliably against real MongoDB (would need to time 4 competing writes exactly right).
    const seed = makeNewSave(ACC, 1000);
    const row: { _id: string; save: SaveData; rev: number } = { _id: ACC, save: seed, rev: seed.rev };
    let findOneCalls = 0;
    const alwaysConflict = {
      async findOne(q: Record<string, unknown>) {
        findOneCalls++;
        return q._id === ACC ? row : null;
      },
      async findOneAndUpdate() {
        return null; // perpetual rev conflict
      },
    };
    const cols = { saves: alwaysConflict } as unknown as Collections;

    await expect(grantTitleToPlayer(cols, ACC, 'ach.never', 5000)).resolves.toBeUndefined();
    expect(findOneCalls).toBe(4); // all 4 attempts were spent
    expect(row.save.titles).not.toContain('ach.never');
    expect(row.save.titleGrants?.['ach.never']).toBeUndefined();
  });
});
