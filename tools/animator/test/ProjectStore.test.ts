// ProjectStore (src/io/ProjectStore.ts) — the IndexedDB project library behind auto-save.
// Backed by `fake-indexeddb`, a spec-compliant IndexedDB for Node, so these tests drive the REAL
// class against a REAL (if in-memory) database rather than a hand-rolled fake of the store's own
// API — same reasoning as animator's io tests using real JSZip instead of asserting "JSZip.file
// was called". vfx-editor's ProjectStore.test.ts set this precedent (ADR-070 Phase 4d).
//
// Isolation note, inherited from that precedent and re-verified here: DB_NAME/DB_VERSION and the
// two store names are fixed module constants, so no test can get its own database.
// `indexedDB.deleteDatabase()` is the obvious per-test reset and is a trap — ProjectStore never
// closes the connection it opens, and a delete request against a db with a live connection only
// fires `onblocked`, never completing; fake-indexeddb then queues every later open()/transaction()
// on that name behind the pending delete and the whole file hangs to the hook timeout. Each test
// instead clears both object stores through a short-lived raw connection it closes immediately,
// so nothing is ever left pending.
//
// Also deliberately NO `vi.useFakeTimers()` anywhere in this file: fake-indexeddb drives its own
// async simulation through real timers, and taking those over deadlocks it (recorded in
// claudedocs/animator.md; it is why AutoSaveController.test.ts — which does need fake timers for
// the 1500ms debounce — uses an in-memory FakeStore instead of this one).
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectStore, type ProjectMeta } from '../src/io/ProjectStore';

const DB_NAME = 'nw-animator';
const STORES = ['meta', 'blobs'] as const;

async function rawOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) {
        if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function clearStores(): Promise<void> {
  // Let ProjectStore's own open() be what creates the schema on the very first call of the run —
  // otherwise rawOpen() below would get there first and the class's `onupgradeneeded` branch would
  // never execute in this file at all (its assertions would still pass, against a schema the test
  // helper built).
  await new ProjectStore().listMeta();
  const db = await rawOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...STORES], 'readwrite');
    for (const s of STORES) tx.objectStore(s).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Read a stored blob back as text. Node's Blob has a real `text()`, and the point of several
 *  assertions below is that the BYTES survive the round trip, not just that a Blob came back. */
async function textOf(blob: Blob | undefined): Promise<string | undefined> {
  return blob ? await blob.text() : undefined;
}

function meta(id: string, name: string, updatedAt: number): ProjectMeta {
  return { id, name, updatedAt };
}

function zip(body: string): Blob {
  return new Blob([body], { type: 'application/zip' });
}

beforeEach(async () => {
  await clearStores();
});

describe('empty store', () => {
  it('listMeta() is empty and getBlob() is undefined for any id', async () => {
    const store = new ProjectStore();
    expect(await store.listMeta()).toEqual([]);
    expect(await store.getBlob('nope')).toBeUndefined();
  });
});

describe('put / getBlob / listMeta', () => {
  it('stores metadata and blob together and reads both back', async () => {
    const store = new ProjectStore();
    await store.put(meta('p1', 'Archer', 1000), zip('archer-bytes'));

    expect(await store.listMeta()).toEqual([meta('p1', 'Archer', 1000)]);
    expect(await textOf(await store.getBlob('p1'))).toBe('archer-bytes');
  });

  it('sorts listMeta() most-recently-updated first, regardless of insertion order', async () => {
    const store = new ProjectStore();
    await store.put(meta('old', 'Old', 100), zip('a'));
    await store.put(meta('newest', 'Newest', 900), zip('b'));
    await store.put(meta('mid', 'Mid', 500), zip('c'));

    expect((await store.listMeta()).map((m) => m.id)).toEqual(['newest', 'mid', 'old']);
  });

  it('overwrites both stores when put() reuses an id', async () => {
    const store = new ProjectStore();
    await store.put(meta('p1', 'First', 100), zip('v1'));
    await store.put(meta('p1', 'Renamed', 200), zip('v2'));

    expect(await store.listMeta()).toEqual([meta('p1', 'Renamed', 200)]);
    expect(await textOf(await store.getBlob('p1'))).toBe('v2');
  });

  it('keeps separate projects independent', async () => {
    const store = new ProjectStore();
    await store.put(meta('a', 'A', 1), zip('bytes-a'));
    await store.put(meta('b', 'B', 2), zip('bytes-b'));

    expect(await textOf(await store.getBlob('a'))).toBe('bytes-a');
    expect(await textOf(await store.getBlob('b'))).toBe('bytes-b');
  });

  // The reason the class has two object stores at all (see its header comment): the project
  // dropdown lists names without pulling megabytes of zip through. Pin that listMeta() really
  // does not carry the blob, so a future "simplification" into one store fails here.
  it('listMeta() returns only {id,name,updatedAt} — never the blob', async () => {
    const store = new ProjectStore();
    await store.put(meta('p1', 'Archer', 1000), zip('a-very-large-archive'));

    const [row] = await store.listMeta();
    expect(Object.keys(row!).sort()).toEqual(['id', 'name', 'updatedAt']);
  });
});

describe('putMeta', () => {
  it('renames without touching the blob', async () => {
    const store = new ProjectStore();
    await store.put(meta('p1', 'Old name', 100), zip('untouched'));
    await store.putMeta(meta('p1', 'New name', 250));

    expect(await store.listMeta()).toEqual([meta('p1', 'New name', 250)]);
    expect(await textOf(await store.getBlob('p1'))).toBe('untouched');
  });

  // putMeta() writes only the meta store, so a metadata row can exist with no blob behind it.
  // AutoSaveController.switchTo() depends on being able to detect exactly that (`if (!blob ||
  // !meta)`), so it is a real reachable state rather than a hypothetical.
  it('can create a metadata row with no blob behind it', async () => {
    const store = new ProjectStore();
    await store.putMeta(meta('ghost', 'Ghost', 1));

    expect((await store.listMeta()).map((m) => m.id)).toEqual(['ghost']);
    expect(await store.getBlob('ghost')).toBeUndefined();
  });
});

describe('delete', () => {
  it('removes metadata and blob together', async () => {
    const store = new ProjectStore();
    await store.put(meta('p1', 'Doomed', 100), zip('x'));
    await store.delete('p1');

    expect(await store.listMeta()).toEqual([]);
    expect(await store.getBlob('p1')).toBeUndefined();
  });

  it('leaves other projects alone', async () => {
    const store = new ProjectStore();
    await store.put(meta('keep', 'Keep', 1), zip('keep-bytes'));
    await store.put(meta('drop', 'Drop', 2), zip('drop-bytes'));
    await store.delete('drop');

    expect((await store.listMeta()).map((m) => m.id)).toEqual(['keep']);
    expect(await textOf(await store.getBlob('keep'))).toBe('keep-bytes');
  });

  it('is a no-op for an unknown id', async () => {
    const store = new ProjectStore();
    await store.put(meta('p1', 'P', 1), zip('x'));
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
    expect((await store.listMeta()).map((m) => m.id)).toEqual(['p1']);
  });
});

describe('connection reuse and persistence', () => {
  // `open()` memoises its promise, so the second call must not re-run onupgradeneeded (which
  // would throw against an already-current version) nor open a second connection.
  it('reuses one connection across many operations on the same instance', async () => {
    const store = new ProjectStore();
    await store.put(meta('p1', 'A', 1), zip('a'));
    await store.putMeta(meta('p1', 'B', 2));
    await store.put(meta('p2', 'C', 3), zip('c'));
    await store.delete('p1');

    expect((await store.listMeta()).map((m) => m.id)).toEqual(['p2']);
  });

  // Two instances is what actually happens across a page reload: the data has to be there.
  it('a second instance sees what the first one wrote', async () => {
    await new ProjectStore().put(meta('p1', 'Persisted', 42), zip('still-here'));

    const reopened = new ProjectStore();
    expect(await reopened.listMeta()).toEqual([meta('p1', 'Persisted', 42)]);
    expect(await textOf(await reopened.getBlob('p1'))).toBe('still-here');
  });
});

describe('schema creation', () => {
  // The onupgradeneeded branch is guarded by `objectStoreNames.contains(...)`. Both stores must
  // exist after a first-ever open, and opening again must not fail on the already-created ones.
  it('creates both object stores on first open and tolerates reopening', async () => {
    const store = new ProjectStore();
    await store.listMeta();

    const db = await rawOpen();
    expect([...db.objectStoreNames].sort()).toEqual(['blobs', 'meta']);
    db.close();

    await expect(new ProjectStore().listMeta()).resolves.toEqual([]);
  });
});
