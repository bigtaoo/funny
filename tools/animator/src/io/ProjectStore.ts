// ── ProjectStore ──────────────────────────────────────────────────────────────
// IndexedDB-backed library of saved animator projects. Each project is one
// `.tao.editor` zip blob (built by IOController) plus lightweight metadata.
//
// Two object stores keep listing cheap: `meta` holds only {id,name,updatedAt}
// so the project dropdown can render without pulling megabytes of blob data;
// `blobs` holds the actual zip, read only when a project is opened.

export interface ProjectMeta {
  id:        string;
  name:      string;
  updatedAt: number;   // epoch ms — used to sort most-recent-first
}

interface BlobRecord {
  id:   string;
  blob: Blob;
}

const DB_NAME      = 'nw-animator';
const DB_VERSION   = 1;
const META_STORE   = 'meta';
const BLOB_STORE   = 'blobs';

/** Wrap an IDBRequest in a Promise. */
function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error ?? new Error('IndexedDB request failed'));
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
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
    });
    return this.dbPromise;
  }

  /** All project metadata, sorted most-recently-updated first. */
  async listMeta(): Promise<ProjectMeta[]> {
    const db = await this.open();
    const tx = db.transaction(META_STORE, 'readonly');
    const all = await reqToPromise(tx.objectStore(META_STORE).getAll() as IDBRequest<ProjectMeta[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getBlob(id: string): Promise<Blob | undefined> {
    const db = await this.open();
    const tx = db.transaction(BLOB_STORE, 'readonly');
    const rec = await reqToPromise(tx.objectStore(BLOB_STORE).get(id) as IDBRequest<BlobRecord | undefined>);
    return rec?.blob;
  }

  /** Write both metadata and blob atomically (create or overwrite). */
  async put(meta: ProjectMeta, blob: Blob): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([META_STORE, BLOB_STORE], 'readwrite');
    tx.objectStore(META_STORE).put(meta);
    tx.objectStore(BLOB_STORE).put({ id: meta.id, blob } satisfies BlobRecord);
    await this.txDone(tx);
  }

  /** Update metadata only (e.g. rename) without touching the blob. */
  async putMeta(meta: ProjectMeta): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(meta);
    await this.txDone(tx);
  }

  async delete(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([META_STORE, BLOB_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(id);
    tx.objectStore(BLOB_STORE).delete(id);
    await this.txDone(tx);
  }

  private txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort    = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }
}
