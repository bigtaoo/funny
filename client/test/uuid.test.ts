// Regression coverage for platform/uuid.ts — previously zero tests despite backing the anonymous
// device identity used for Web/CrazyGames analytics (S0-4). Covers all three genUuid() generation
// paths, the getOrCreateDeviceId() persistence contract, and the 2026-09-23 IndexedDB dual-write /
// recovery layer (RETENTION_LAUNCH_PLAN.md §1.1).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { genUuid, getOrCreateDeviceId } from '../src/platform/uuid';
import type { IStorage } from '../src/platform/IPlatform';

function memStore(): IStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

/**
 * Minimal in-memory fake of the tiny slice of IndexedDB `uuid.ts` actually uses: one object store,
 * `get`/`put` by key, `onupgradeneeded`/`onsuccess`/`onerror` on the open request, `oncomplete` on
 * the readwrite transaction. vitest here runs `environment: 'node'`, which has no real `indexedDB`
 * global at all — this fake is what lets the recovery path be exercised instead of only ever hitting
 * `idbGet`'s "unsupported, resolve undefined" branch.
 */
/** A fake IDB request: untyped on purpose (the real `IDBRequest`/`IDBOpenDBRequest` DOM types force
 *  every handler to take an `Event` and forbid a plain writable `.result`, neither of which this
 *  minimal fake needs) — cast to the real type only at the `IDBFactory` boundary below. */
interface FakeReq {
  result?: unknown;
  onsuccess?: (() => void) | null;
  onerror?: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

function fakeIndexedDB(opts: { failOpen?: boolean } = {}): { factory: IDBFactory; backing: Map<string, string> } {
  const backing = new Map<string, string>();
  const request = (build: (req: FakeReq) => void): FakeReq => {
    const req: FakeReq = {};
    build(req);
    // Fire asynchronously (a microtask), like the real IDB API — callers that read `req.result`
    // synchronously right after calling `.open()`/`.get()` would see nothing, same as the real API.
    return req;
  };
  const factory = {
    open: (_name: string, _version?: number) => {
      return request((r) => {
        queueMicrotask(() => {
          if (opts.failOpen) { r.onerror?.(); return; }
          let oncomplete: (() => void) | undefined;
          const fakeDb = {
            createObjectStore: () => ({}),
            transaction: (_store: string, mode: string) => {
              const store = {
                get: (key: unknown) => request((gr) => {
                  queueMicrotask(() => { gr.result = backing.get(String(key)); gr.onsuccess?.(); });
                }),
                put: (value: unknown, key: unknown) => request((pr) => {
                  queueMicrotask(() => {
                    backing.set(String(key), value as string);
                    pr.onsuccess?.();
                    if (mode === 'readwrite') queueMicrotask(() => oncomplete?.());
                  });
                }),
              };
              return { objectStore: () => store, set oncomplete(cb: (() => void) | undefined) { oncomplete = cb; } };
            },
            close: () => { /* no-op fake */ },
          };
          r.result = fakeDb;
          r.onupgradeneeded?.();
          r.onsuccess?.();
        });
      });
    },
  };
  return { factory: factory as unknown as IDBFactory, backing };
}

/** Flush the microtask queue enough times for the fake's chained queueMicrotask calls to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('genUuid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('produces a well-formed v4 UUID via crypto.randomUUID when available (the default path)', () => {
    const id = genUuid();
    expect(id).toMatch(UUID_RE);
  });

  it('produces distinct ids across calls', () => {
    expect(genUuid()).not.toBe(genUuid());
  });

  it('falls back to manual construction via crypto.getRandomValues when randomUUID is absent', () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    const id = genUuid();
    expect(id).toMatch(UUID_RE);
    // Version 4 (bits 6-7 of byte 6 = 0100) and RFC4122 variant (bits 6-7 of byte 8 = 10xx).
    expect(id[14]).toBe('4');
    expect(['8', '9', 'a', 'b']).toContain(id[19]!.toLowerCase());
  });

  it('falls back to a time+random string when crypto is entirely unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    const id = genUuid();
    expect(id.startsWith('dev-')).toBe(true);
    expect(id).not.toMatch(UUID_RE);
  });
});

describe('getOrCreateDeviceId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('generates and persists an id on first call (no indexedDB in this environment — localStorage only)', async () => {
    const store = memStore();
    expect(store.getItem('nw_device_id')).toBeNull();

    const id = await getOrCreateDeviceId(store);
    expect(id).toMatch(UUID_RE);
    expect(store.getItem('nw_device_id')).toBe(id);
  });

  it('returns the same id on subsequent calls instead of generating a new one', async () => {
    const store = memStore();
    const first = await getOrCreateDeviceId(store);
    const second = await getOrCreateDeviceId(store);
    expect(second).toBe(first);
  });

  it('reads back a pre-existing localStorage id without overwriting it', async () => {
    const store = memStore();
    store.setItem('nw_device_id', 'pre-existing-id');
    expect(await getOrCreateDeviceId(store)).toBe('pre-existing-id');
    expect(store.getItem('nw_device_id')).toBe('pre-existing-id');
  });

  it('no indexedDB global at all → still resolves from localStorage alone, never throws/hangs', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const store = memStore();
    const id = await getOrCreateDeviceId(store);
    expect(id).toMatch(UUID_RE);
  });

  it('a fresh id is mirrored into IndexedDB on first call', async () => {
    const { factory, backing } = fakeIndexedDB();
    vi.stubGlobal('indexedDB', factory);
    const store = memStore();
    const id = await getOrCreateDeviceId(store);
    await flush();
    expect(backing.get('nw_device_id')).toBe(id);
  });

  it('localStorage cleared but IndexedDB still has the id → recovers it and re-seeds localStorage', async () => {
    const { factory, backing } = fakeIndexedDB();
    backing.set('nw_device_id', 'idb-recovered-id');
    vi.stubGlobal('indexedDB', factory);
    const store = memStore(); // localStorage: empty, as if wiped independently of IndexedDB
    const id = await getOrCreateDeviceId(store);
    expect(id).toBe('idb-recovered-id');
    expect(store.getItem('nw_device_id')).toBe('idb-recovered-id'); // localStorage re-seeded
  });

  it('IndexedDB open fails → falls back to localStorage/fresh id, never throws', async () => {
    const { factory } = fakeIndexedDB({ failOpen: true });
    vi.stubGlobal('indexedDB', factory);
    const store = memStore();
    const id = await getOrCreateDeviceId(store);
    expect(id).toMatch(UUID_RE);
    expect(store.getItem('nw_device_id')).toBe(id);
  });
});
