// Device UUID generation + persistence (S0-4, Web / CrazyGames anonymous identity).
// Same device always returns the same id: generated on first use and persisted to storage, then read back.
//
// 2026-09-23 (RETENTION_LAUNCH_PLAN.md §1.1): localStorage alone is a single point of failure for D7
// retention measurement and for anonymous-account continuity — browser extensions, a "clear site data"
// button, and storage-pressure eviction can each wipe it independently of any other store. IndexedDB is
// a SEPARATE store with its own eviction path, so mirroring the id into both roughly halves the chance
// any one player loses their identity between sessions. This does NOT defend against Safari ITP's
// script-writable-storage purge (cleared after ~7 days without a top-level-frame visit) — ITP clears
// localStorage and IndexedDB together, since both are "script-writable storage" to it, and CrazyGames
// loads the game in a cross-origin iframe so ITP applies. The real fix for that case is a portal-held
// identity (CrazyGamesPlatform's SDK `user` token, §1.1/§3.1), not more local storage — this module only
// closes the *other* loss paths.

import type { IStorage } from './IPlatform';

const DEVICE_ID_KEY = 'nw_device_id';
const IDB_NAME = 'nw_device';
const IDB_STORE = 'kv';

/** RFC4122 v4 — prefers crypto.randomUUID, falls back to manual construction. */
export function genUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
  }
  // Extreme fallback (no crypto): time + Math.random (device id only, not for security purposes).
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Best-effort IndexedDB read of the persisted device id. Resolves `undefined` on any failure
 * (unsupported, blocked by browser settings, private-mode quota, no `indexedDB` global) — this is a
 * convenience mirror, never a hard requirement, so every failure path resolves rather than rejects.
 */
function idbGet(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) { resolve(undefined); return; }
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(IDB_NAME, 1);
    } catch {
      resolve(undefined);
      return;
    }
    req.onupgradeneeded = () => {
      try { req.result.createObjectStore(IDB_STORE); } catch { /* store already exists */ }
    };
    req.onerror = () => resolve(undefined);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const getReq = tx.objectStore(IDB_STORE).get(DEVICE_ID_KEY);
        getReq.onsuccess = () => { resolve(typeof getReq.result === 'string' ? getReq.result : undefined); db.close(); };
        getReq.onerror = () => { resolve(undefined); db.close(); };
      } catch {
        resolve(undefined);
        db.close();
      }
    };
  });
}

/** Best-effort IndexedDB write; failures are swallowed (same convenience-mirror contract as idbGet). */
function idbSet(id: string): void {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return;
  try {
    const req = idb.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      try { req.result.createObjectStore(IDB_STORE); } catch { /* store already exists */ }
    };
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(id, DEVICE_ID_KEY);
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
      } catch {
        db.close();
      }
    };
    req.onerror = () => { /* swallow: this is a best-effort mirror */ };
  } catch {
    /* swallow: e.g. SecurityError in a locked-down iframe */
  }
}

/**
 * Get stable device id (generated and persisted on first call). localStorage is the fast/primary
 * path — checked first, matches every call site's prior (synchronous) expectation as closely as an
 * async signature allows — and IndexedDB is consulted only when localStorage came back empty, as a
 * recovery source for the case where localStorage specifically was cleared but IndexedDB was not.
 * Async because that recovery read is async; every call site already awaits an async caller
 * (`IPlatform.getAuthCredential()` / `analytics.init()`).
 */
export async function getOrCreateDeviceId(storage: IStorage): Promise<string> {
  const fromLocal = storage.getItem(DEVICE_ID_KEY);
  if (fromLocal) {
    idbSet(fromLocal); // keep the mirror warm even if it fell behind (e.g. IndexedDB was blocked earlier)
    return fromLocal;
  }
  const fromIdb = await idbGet();
  if (fromIdb) {
    storage.setItem(DEVICE_ID_KEY, fromIdb); // localStorage was wiped independently of IndexedDB — recover it
    return fromIdb;
  }
  const id = genUuid();
  storage.setItem(DEVICE_ID_KEY, id);
  idbSet(id);
  return id;
}
