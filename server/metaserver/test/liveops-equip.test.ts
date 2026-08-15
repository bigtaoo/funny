// Cosmetic equip (PUT /avatar/equip, /skin/equip) + preference flags (PUT /flags) unit tests, no Mongo.
// These replace save-patch.test.ts's applySyncPatch-based coverage now that PUT /save (the old generic
// client-sync endpoint) has been removed — every one of these fields is server-authoritative and written
// only through its own validated endpoint (see DECISIONS.md "equipped/flags server-authoritative").
// PUT /title/equip is already covered by titles.test.ts.
import { describe, it, expect } from 'vitest';
import { makeNewSave, signToken, type Collections, type SaveData } from '@nw/shared';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { FakeCollection } from './helpers/fakeCollection.js';

const jwt = { secret: 'test-secret' };

function fakeCols(seed?: { accountId: string; mutate?: (s: SaveData) => void }): Collections {
  const saves = new FakeCollection<{ _id: string; save: SaveData; rev: number }>();
  if (seed) {
    const s = makeNewSave(seed.accountId, 1000);
    seed.mutate?.(s);
    saves.seed({ _id: seed.accountId, save: s, rev: s.rev });
  }
  return { saves } as unknown as Collections;
}

async function makeApp(cols: Collections): Promise<FastifyInstance> {
  return buildApp({ cols, jwt, internalKey: 'k', commercialUrl: null, gatewayUrl: null, authRateLimit: 0 });
}

const ACC = 'acc-1';
const auth = { authorization: `Bearer ${signToken(ACC, jwt)}` };

describe('PUT /avatar/equip', () => {
  it('preset digit → always allowed, no ownership check', async () => {
    const app = await makeApp(fakeCols({ accountId: ACC }));
    const res = await app.inject({ method: 'PUT', url: '/avatar/equip', headers: auth, payload: { avatarId: '3' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.save.equipped.avatar).toBe('3');
    await app.close();
  });

  it('composite id requires the category-specific lifetime-owned record; unowned → 403', async () => {
    const cols = fakeCols({ accountId: ACC, mutate: (s) => { s.everOwned = { hero: ['lichuang'] }; } });
    const app = await makeApp(cols);
    const owned = await app.inject({ method: 'PUT', url: '/avatar/equip', headers: auth, payload: { avatarId: 'hero:lichuang' } });
    expect(owned.statusCode).toBe(200);
    expect(owned.json().data.save.equipped.avatar).toBe('hero:lichuang');

    const unowned = await app.inject({ method: 'PUT', url: '/avatar/equip', headers: auth, payload: { avatarId: 'hero:never_obtained' } });
    expect(unowned.statusCode).toBe(403);
    await app.close();
  });

  it('title/skin categories each check their own lifetime-owned bucket', async () => {
    const cols = fakeCols({
      accountId: ACC,
      mutate: (s) => {
        s.titles = ['season1_gold'];
        s.inventory.skins = ['owned_skin'];
      },
    });
    const app = await makeApp(cols);
    for (const avatarId of ['title:season1_gold', 'skin:owned_skin']) {
      const res = await app.inject({ method: 'PUT', url: '/avatar/equip', headers: auth, payload: { avatarId } });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.save.equipped.avatar).toBe(avatarId);
    }
    const unowned = await app.inject({ method: 'PUT', url: '/avatar/equip', headers: auth, payload: { avatarId: 'skin:never_had' } });
    expect(unowned.statusCode).toBe(403);
    await app.close();
  });

  it('equip/material avatar categories were retired (2026-08-15) → always 403, even if the item is owned', async () => {
    const cols = fakeCols({
      accountId: ACC,
      mutate: (s) => { s.everOwned = { equipment: ['sword_def'], material: ['scrap'] }; },
    });
    const app = await makeApp(cols);
    for (const avatarId of ['equip:sword_def', 'material:scrap']) {
      const res = await app.inject({ method: 'PUT', url: '/avatar/equip', headers: auth, payload: { avatarId } });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it('a stored equip:*/material:* avatarId (from before the 2026-08-15 retirement) is silently swapped to the preset default on read', async () => {
    const cols = fakeCols({ accountId: ACC, mutate: (s) => { s.equipped = { avatar: 'equip:sword_def' }; } });
    const app = await makeApp(cols);
    // Any endpoint returning `data.save` exercises the preSerialization hook — PUT /flags is a
    // neutral one that doesn't touch equipped.avatar itself.
    const res = await app.inject({ method: 'PUT', url: '/flags', headers: auth, payload: { key: 'x', value: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.save.equipped.avatar).toBe('preset:0');
    await app.close();
  });

  it('empty avatarId → unequip', async () => {
    const cols = fakeCols({ accountId: ACC, mutate: (s) => { s.equipped = { avatar: '3' }; } });
    const app = await makeApp(cols);
    const res = await app.inject({ method: 'PUT', url: '/avatar/equip', headers: auth, payload: { avatarId: '' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.save.equipped.avatar).toBeUndefined();
    await app.close();
  });
});

describe('PUT /skin/equip', () => {
  it('owned skin (current inventory) → equips into equipped["skin:<unitType>"]', async () => {
    const cols = fakeCols({ accountId: ACC, mutate: (s) => { s.inventory.skins = ['scholar_gold']; } });
    const app = await makeApp(cols);
    const res = await app.inject({
      method: 'PUT', url: '/skin/equip', headers: auth,
      payload: { unitType: 'Scholar', skinId: 'scholar_gold' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.save.equipped['skin:Scholar']).toBe('scholar_gold');
    await app.close();
  });

  it('owned skin via lifetime ledger (auction-escrowed away from current inventory) → still allowed', async () => {
    const cols = fakeCols({ accountId: ACC, mutate: (s) => { s.everOwned = { skin: ['warrior_festival'] }; } });
    const app = await makeApp(cols);
    const res = await app.inject({
      method: 'PUT', url: '/skin/equip', headers: auth,
      payload: { unitType: 'Warrior', skinId: 'warrior_festival' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.save.equipped['skin:Warrior']).toBe('warrior_festival');
    await app.close();
  });

  it('unowned skin → 403, slot left untouched', async () => {
    const app = await makeApp(fakeCols({ accountId: ACC }));
    const res = await app.inject({
      method: 'PUT', url: '/skin/equip', headers: auth,
      payload: { unitType: 'Warrior', skinId: 'never_owned_skin' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('null skinId → unequip the slot', async () => {
    const cols = fakeCols({ accountId: ACC, mutate: (s) => { s.equipped = { 'skin:Scholar': 'scholar_gold' }; } });
    const app = await makeApp(cols);
    const res = await app.inject({
      method: 'PUT', url: '/skin/equip', headers: auth,
      payload: { unitType: 'Scholar', skinId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.save.equipped['skin:Scholar']).toBeUndefined();
    await app.close();
  });

  it('missing unitType → 400', async () => {
    const app = await makeApp(fakeCols({ accountId: ACC }));
    const res = await app.inject({ method: 'PUT', url: '/skin/equip', headers: auth, payload: { skinId: 'x' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('PUT /flags', () => {
  it('sets one flag by key, leaving others untouched', async () => {
    const cols = fakeCols({ accountId: ACC, mutate: (s) => { s.flags = { seen_intro: true }; } });
    const app = await makeApp(cols);
    const res = await app.inject({ method: 'PUT', url: '/flags', headers: auth, payload: { key: 'tutorial_done', value: true } });
    expect(res.statusCode).toBe(200);
    const flags = res.json().data.save.flags;
    expect(flags.tutorial_done).toBe(true);
    expect(flags.seen_intro).toBe(true); // untouched
    await app.close();
  });

  it('dynamic featSeen.<id> namespace key round-trips (literal dot in the key, not a nested path)', async () => {
    const app = await makeApp(fakeCols({ accountId: ACC }));
    const res = await app.inject({ method: 'PUT', url: '/flags', headers: auth, payload: { key: 'featSeen.roster', value: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.save.flags['featSeen.roster']).toBe(true);
    await app.close();
  });

  it('can flip a flag back to false', async () => {
    const cols = fakeCols({ accountId: ACC, mutate: (s) => { s.flags = { gdprConsent: true }; } });
    const app = await makeApp(cols);
    const res = await app.inject({ method: 'PUT', url: '/flags', headers: auth, payload: { key: 'gdprConsent', value: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.save.flags.gdprConsent).toBe(false);
    await app.close();
  });

  it('missing key / non-boolean value → 400', async () => {
    const app = await makeApp(fakeCols({ accountId: ACC }));
    const noKey = await app.inject({ method: 'PUT', url: '/flags', headers: auth, payload: { value: true } });
    expect(noKey.statusCode).toBe(400);
    const badValue = await app.inject({ method: 'PUT', url: '/flags', headers: auth, payload: { key: 'x', value: 'yes' } });
    expect(badValue.statusCode).toBe(400);
    await app.close();
  });
});
