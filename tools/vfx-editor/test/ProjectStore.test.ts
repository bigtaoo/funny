// ProjectStore (src/io/ProjectStore.ts) — IndexedDB-backed effect library. Backed here by
// `fake-indexeddb`, a spec-compliant IndexedDB implementation for Node — this drives the REAL
// class against a REAL (if in-memory) IndexedDB, not a hand-rolled mock of the store's own API.
//
// Isolation note: DB_NAME/STORE ('nw-vfx'/'effects') are fixed module constants, so tests can't
// give each run its own db. `indexedDB.deleteDatabase()` looked like the obvious per-test reset,
// but ProjectStore never closes its IDBDatabase connections — a delete request against a db with
// an open connection only fires `onblocked` and never actually completes, and fake-indexeddb then
// queues every later open()/transaction() on that same db name behind the still-pending delete,
// hanging forever (repro'd standalone before landing this file). Instead each test clears the
// object store's contents via a short-lived raw connection that closes itself immediately after —
// never touching deleteDatabase, so nothing is ever left pending.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import type { EffectDef } from '@vfx/types';
import { ProjectStore, EffectRecord } from '../src/io/ProjectStore';

function makeDef(id: string): EffectDef {
  return { id, duration: 1, layers: [{ type: 'ring' }] };
}

async function clearStore(): Promise<void> {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const req = indexedDB.open('nw-vfx', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('effects')) req.result.createObjectStore('effects', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('effects', 'readwrite');
    tx.objectStore('effects').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

beforeEach(async () => {
  await clearStore();
});

describe('list / get on an empty store', () => {
  it('list() returns an empty array; get() returns undefined for any id; count() is 0', async () => {
    const store = new ProjectStore();
    expect(await store.list()).toEqual([]);
    expect(await store.get('nope')).toBeUndefined();
    expect(await store.count()).toBe(0);
  });
});

describe('put / get round-trip', () => {
  it('put() then get() returns back the exact record, including nested layer data', async () => {
    const store = new ProjectStore();
    const rec: EffectRecord = { id: 'e1', def: makeDef('e1'), updatedAt: 1000 };
    await store.put(rec);
    expect(await store.get('e1')).toEqual(rec);
  });

  it('put() with an existing id overwrites (upsert), not duplicates', async () => {
    const store = new ProjectStore();
    await store.put({ id: 'e1', def: makeDef('e1'), updatedAt: 1000 });
    await store.put({ id: 'e1', def: makeDef('e1-renamed'), updatedAt: 2000 });
    expect(await store.count()).toBe(1);
    expect((await store.get('e1'))!.def.id).toBe('e1-renamed');
  });
});

describe('list ordering', () => {
  it('sorts most-recently-updated first', async () => {
    const store = new ProjectStore();
    await store.put({ id: 'old', def: makeDef('old'), updatedAt: 100 });
    await store.put({ id: 'newest', def: makeDef('newest'), updatedAt: 300 });
    await store.put({ id: 'mid', def: makeDef('mid'), updatedAt: 200 });
    const list = await store.list();
    expect(list.map((r) => r.id)).toEqual(['newest', 'mid', 'old']);
  });
});

describe('delete', () => {
  it('removes the record; get() afterward is undefined, count() drops', async () => {
    const store = new ProjectStore();
    await store.put({ id: 'e1', def: makeDef('e1'), updatedAt: 1 });
    await store.delete('e1');
    expect(await store.get('e1')).toBeUndefined();
    expect(await store.count()).toBe(0);
  });

  it('deleting a nonexistent id is a silent no-op', async () => {
    const store = new ProjectStore();
    await store.put({ id: 'e1', def: makeDef('e1'), updatedAt: 1 });
    await store.delete('does-not-exist');
    expect(await store.count()).toBe(1);
  });
});

describe('multiple ProjectStore instances share the same underlying db', () => {
  it('a write from one instance is visible to a fresh instance', async () => {
    const writer = new ProjectStore();
    await writer.put({ id: 'e1', def: makeDef('e1'), updatedAt: 1 });
    const reader = new ProjectStore();
    expect(await reader.get('e1')).toBeDefined();
  });
});
