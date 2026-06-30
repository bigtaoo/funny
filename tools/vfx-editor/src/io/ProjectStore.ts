/**
 * ProjectStore.ts — IndexedDB-backed library of effects being edited.
 *
 * Each record is one effect's JSON (EffectDef) plus an internal id and updatedAt.
 * The internal id is stable across `effect.id` renames so the list selection
 * survives a rename. Built-in effects (shipped in the repo) are seeded with
 * deterministic ids ("builtin:<id>") on first run; user effects get a uuid.
 *
 * Mirrors animator's nw-animator store but stores plain JSON (not zip blobs),
 * since effects are tiny (DESIGN §8: autosave targets the IndexedDB working copy only).
 */
import { EffectDef } from '@vfx/types';

export interface EffectRecord {
  id: string;        // internal id (stable across renames)
  def: EffectDef;
  updatedAt: number; // epoch ms
}

const DB_NAME = 'nw-vfx';
const DB_VERSION = 1;
const STORE = 'effects';

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export class ProjectStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
    });
    return this.dbPromise;
  }

  /** All records, most-recently-updated first. */
  async list(): Promise<EffectRecord[]> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readonly');
    const all = await reqToPromise(tx.objectStore(STORE).getAll() as IDBRequest<EffectRecord[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<EffectRecord | undefined> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readonly');
    return reqToPromise(tx.objectStore(STORE).get(id) as IDBRequest<EffectRecord | undefined>);
  }

  async put(rec: EffectRecord): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    await this.txDone(tx);
  }

  async delete(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await this.txDone(tx);
  }

  async count(): Promise<number> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readonly');
    return reqToPromise(tx.objectStore(STORE).count());
  }

  private txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }
}
