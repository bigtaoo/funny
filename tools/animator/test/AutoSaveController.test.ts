// AutoSaveController (src/io/AutoSaveController.ts) — the "currently open project" owner: debounced
// silent persistence to IndexedDB, the project library (create/switch/duplicate/rename/delete), and
// last-open restore. ADR-070 Phase 4d: it was 0% covered.
//
// WHY A FakeStore INSTEAD OF fake-indexeddb HERE, when ProjectStore.test.ts uses the real thing:
// every interesting behaviour in this class is about the 1500ms debounce, so the tests need
// `vi.useFakeTimers()` — and fake timers plus `fake-indexeddb` deadlock. fake-indexeddb runs its
// own async simulation on real timers, and once vitest owns those, its queued work is never
// scheduled again, so the file hangs to the hook timeout rather than failing. vfx-editor hit this
// exact wall in Library.test.ts and resolved it the same way (recorded in claudedocs/animator.md).
// The trade is explicit and cheap: ProjectStore's own correctness is pinned against a REAL
// IndexedDB in ProjectStore.test.ts, so what this file needs from a store is only that it behaves
// like one — and an in-memory Map does that observably, plus it can count writes.
//
// `document` / `window` / `localStorage` are stubbed via vi.stubGlobal (same technique as
// fileIO.test.ts), and the stubbed document/window keep their listeners reachable so the
// visibilitychange / beforeunload flush paths can be fired rather than assumed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../src/core/EventBus';
import { AutoSaveController, DIRTY_EVENTS } from '../src/io/AutoSaveController';
import type { ProjectStore, ProjectMeta } from '../src/io/ProjectStore';
import type { IOController } from '../src/io/IOController';

const DEBOUNCE_MS = 1500;
const LS_ACTIVE_KEY = 'nw-animator:activeProject';

/** In-memory stand-in for ProjectStore, matching the five methods AutoSaveController calls.
 *  Records every write so the debounce tests can assert "one save, not three". */
class FakeStore {
  readonly metas = new Map<string, ProjectMeta>();
  readonly blobs = new Map<string, Blob>();
  puts: Array<{ meta: ProjectMeta; body: string }> = [];

  async listMeta(): Promise<ProjectMeta[]> {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async getBlob(id: string): Promise<Blob | undefined> {
    return this.blobs.get(id);
  }
  async put(meta: ProjectMeta, blob: Blob): Promise<void> {
    this.metas.set(meta.id, { ...meta });
    this.blobs.set(meta.id, blob);
    this.puts.push({ meta: { ...meta }, body: (blob as Blob & { _body?: string })._body ?? '' });
  }
  async putMeta(meta: ProjectMeta): Promise<void> {
    this.metas.set(meta.id, { ...meta });
  }
  async delete(id: string): Promise<void> {
    this.metas.delete(id);
    this.blobs.delete(id);
  }
  asStore(): ProjectStore {
    return this as unknown as ProjectStore;
  }
}

/** A Blob carrying an inspectable tag, so tests can prove WHICH snapshot was written. Real Blob
 *  reads are async and the debounce assertions are synchronous after `advanceTimersByTime`. */
function taggedBlob(body: string): Blob {
  const b = new Blob([body]) as Blob & { _body: string };
  b._body = body;
  return b;
}

/** Stand-in for IOController: AutoSaveController only ever calls buildEditorBlob/loadEditorBlob. */
function fakeIo() {
  let snapshot = 'snapshot-0';
  const loads: Array<{ body: string; label: string }> = [];
  const api = {
    buildEditorBlob: vi.fn(async () => taggedBlob(snapshot)),
    loadEditorBlob: vi.fn(async (blob: Blob, label: string) => {
      loads.push({ body: (blob as Blob & { _body?: string })._body ?? '', label });
      return true;
    }),
  };
  return {
    ...api,
    loads,
    /** Change what the next buildEditorBlob() returns — i.e. "the artist edited something". */
    setSnapshot(s: string) { snapshot = s; },
    asIo(): IOController { return api as unknown as IOController; },
  };
}

interface Harness {
  bus: EventBus<AppEvents>;
  store: FakeStore;
  io: ReturnType<typeof fakeIo>;
  ctrl: AutoSaveController;
  events: Array<{ event: string; payload: unknown }>;
  resets: number;
  fireVisibility(state: 'hidden' | 'visible'): void;
  fireBeforeUnload(): void;
}

let docListeners: Map<string, Array<() => void>>;
let winListeners: Map<string, Array<() => void>>;
let visibility: 'hidden' | 'visible';
let ls: Map<string, string>;

function stubBrowser(): void {
  docListeners = new Map();
  winListeners = new Map();
  visibility = 'visible';
  ls = new Map();
  vi.stubGlobal('document', {
    addEventListener: (ev: string, cb: () => void) => {
      docListeners.set(ev, [...(docListeners.get(ev) ?? []), cb]);
    },
    get visibilityState() { return visibility; },
  });
  vi.stubGlobal('window', {
    addEventListener: (ev: string, cb: () => void) => {
      winListeners.set(ev, [...(winListeners.get(ev) ?? []), cb]);
    },
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as number,
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => { ls.set(k, v); },
    removeItem: (k: string) => { ls.delete(k); },
  });
}

function makeHarness(seed?: (store: FakeStore) => void): Harness {
  const bus = new EventBus<AppEvents>();
  const store = new FakeStore();
  seed?.(store);
  const io = fakeIo();
  const events: Array<{ event: string; payload: unknown }> = [];
  for (const ev of ['project:list', 'project:active', 'autosave:state', 'error'] as const) {
    bus.on(ev, (p: unknown) => events.push({ event: ev, payload: p }));
  }
  const h = { resets: 0 } as Harness;
  const ctrl = new AutoSaveController(store.asStore(), io.asIo(), bus, () => { h.resets++; });
  Object.assign(h, {
    bus, store, io, ctrl, events,
    fireVisibility(state: 'hidden' | 'visible') {
      visibility = state;
      for (const cb of docListeners.get('visibilitychange') ?? []) cb();
    },
    fireBeforeUnload() {
      for (const cb of winListeners.get('beforeunload') ?? []) cb();
    },
  });
  return h;
}

/** Let every already-resolved promise in the chain settle. The class awaits several store calls
 *  per operation, and fake timers do not advance microtasks. */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Cross the debounce boundary and let the resulting async flush finish. */
async function tick(ms = DEBOUNCE_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

function meta(id: string, name: string, updatedAt: number): ProjectMeta {
  return { id, name, updatedAt };
}

beforeEach(() => {
  stubBrowser();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bootstrap', () => {
  it('adopts the booted state as a new "Untitled" project when the library is empty', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();

    expect(h.resets).toBe(1);
    expect(h.ctrl.activeName).toBe('Untitled');
    expect(h.ctrl.activeId).not.toBeNull();
    expect(h.store.puts).toHaveLength(1);
    expect(h.store.puts[0]!.meta.name).toBe('Untitled');
    expect(ls.get(LS_ACTIVE_KEY)).toBe(h.ctrl.activeId);
    expect(h.events.map((e) => e.event)).toEqual(['project:active', 'project:list']);
  });

  it('restores the project localStorage points at, not merely the newest one', async () => {
    const h = makeHarness((s) => {
      s.metas.set('older', meta('older', 'Older', 100));
      s.blobs.set('older', taggedBlob('older-zip'));
      s.metas.set('newest', meta('newest', 'Newest', 900));
      s.blobs.set('newest', taggedBlob('newest-zip'));
    });
    ls.set(LS_ACTIVE_KEY, 'older');

    await h.ctrl.bootstrap();

    expect(h.ctrl.activeId).toBe('older');
    expect(h.ctrl.activeName).toBe('Older');
    expect(h.io.loads).toEqual([{ body: 'older-zip', label: 'Older' }]);
    expect(h.resets).toBe(0);          // restoring is not a reset
    expect(h.store.puts).toHaveLength(0);
  });

  it('falls back to the most-recently-updated project when the remembered id is gone', async () => {
    const h = makeHarness((s) => {
      s.metas.set('a', meta('a', 'A', 100));
      s.blobs.set('a', taggedBlob('a-zip'));
      s.metas.set('b', meta('b', 'B', 900));
      s.blobs.set('b', taggedBlob('b-zip'));
    });
    ls.set(LS_ACTIVE_KEY, 'deleted-on-another-machine');

    await h.ctrl.bootstrap();

    expect(h.ctrl.activeId).toBe('b');
  });

  // The restore path runs through runSuspended(): loadEditorBlob makes the model emit its own
  // dirty events, and those must not mark the just-loaded project dirty and re-save it.
  it('does not schedule a save for the dirty events its own restore provokes', async () => {
    const h = makeHarness((s) => {
      s.metas.set('a', meta('a', 'A', 100));
      s.blobs.set('a', taggedBlob('a-zip'));
    });
    h.io.loadEditorBlob.mockImplementation(async () => {
      h.bus.emit('kf:change');          // exactly what a real load does
      h.bus.emit('rig:change');
      return true;
    });

    await h.ctrl.bootstrap();
    await tick();

    expect(h.store.puts).toHaveLength(0);
    expect(h.events.filter((e) => e.event === 'autosave:state').map((e) => e.payload)).toEqual(['saved']);
  });
});

describe('debounced auto-save', () => {
  async function booted(): Promise<Harness> {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    h.store.puts.length = 0;
    h.events.length = 0;
    return h;
  }

  it.each(DIRTY_EVENTS)('%s schedules a save', async (ev) => {
    const h = await booted();
    h.bus.emit(ev as 'kf:change');

    expect(h.events.map((e) => e.payload)).toEqual(['dirty']);
    await tick();
    expect(h.store.puts).toHaveLength(1);
  });

  it('does not fire before the debounce window elapses', async () => {
    const h = await booted();
    h.bus.emit('kf:change');

    await tick(DEBOUNCE_MS - 1);
    expect(h.store.puts).toHaveLength(0);
    await tick(1);
    expect(h.store.puts).toHaveLength(1);
  });

  it('collapses a burst of edits into a single write of the LAST snapshot', async () => {
    const h = await booted();

    h.io.setSnapshot('edit-1');
    h.bus.emit('kf:change');
    await tick(500);
    h.io.setSnapshot('edit-2');
    h.bus.emit('binding:change', 'spine');
    await tick(500);
    h.io.setSnapshot('edit-3');
    h.bus.emit('rig:change');
    await tick(DEBOUNCE_MS);

    expect(h.store.puts).toHaveLength(1);
    expect(h.store.puts[0]!.body).toBe('edit-3');
    // dirty is announced per edit; saving/saved only once.
    expect(h.events.map((e) => e.payload)).toEqual(['dirty', 'dirty', 'dirty', 'saving', 'saved', undefined]);
    expect(h.events[h.events.length - 1]!.event).toBe('project:list');
  });

  it('stamps updatedAt so the dropdown reorders, and keeps the id/name', async () => {
    const h = await booted();
    const id = h.ctrl.activeId!;
    vi.setSystemTime(new Date('2026-08-20T13:00:00Z'));

    h.bus.emit('kf:change');
    await tick();

    expect(h.store.puts[0]!.meta).toEqual({ id, name: 'Untitled', updatedAt: Date.now() });
  });

  it('a settled project stays settled — the timer does not re-fire on its own', async () => {
    const h = await booted();
    h.bus.emit('kf:change');
    await tick();
    expect(h.store.puts).toHaveLength(1);

    await tick(DEBOUNCE_MS * 3);
    expect(h.store.puts).toHaveLength(1);
  });

  it('reports a build failure as an error event and leaves the project dirty', async () => {
    const h = await booted();
    h.io.buildEditorBlob.mockRejectedValueOnce(new Error('zip exploded'));

    h.bus.emit('kf:change');
    await tick();

    expect(h.events.find((e) => e.event === 'error')?.payload).toBe('Auto-save failed: zip exploded');
    expect(h.store.puts).toHaveLength(0);
    // Still dirty, so the next edit's debounce retries rather than dropping the work.
    h.io.buildEditorBlob.mockImplementation(async () => taggedBlob('retry'));
    h.bus.emit('kf:change');
    await tick();
    expect(h.store.puts.map((p) => p.body)).toEqual(['retry']);
  });

  // Before bootstrap there is no active project to save into, so dirty events must be dropped
  // rather than queued — otherwise the first flush would write to `null`.
  it('ignores dirty events fired before bootstrap', async () => {
    const h = makeHarness();
    h.bus.emit('kf:change');
    await tick();

    expect(h.store.puts).toHaveLength(0);
    expect(h.events).toEqual([]);
  });
});

describe('tab hide / close flush', () => {
  it('flushes pending edits immediately when the tab is hidden', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    h.store.puts.length = 0;

    h.io.setSnapshot('unsaved-edit');
    h.bus.emit('kf:change');
    h.fireVisibility('hidden');
    await settle();

    expect(h.store.puts.map((p) => p.body)).toEqual(['unsaved-edit']);
    // The pending debounce must be CANCELLED, not merely rendered harmless. Asserting on the
    // second write alone is not enough: flushNow() clears `dirty`, so a surviving timer would fire
    // into a no-op and the write count would look identical either way. Deleting the clearTimeout
    // from flushNow() left this file green until the timer count was asserted directly.
    expect(vi.getTimerCount()).toBe(0);
    await tick();
    expect(h.store.puts).toHaveLength(1);
  });

  it('does nothing when the tab becomes hidden with nothing pending', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    h.store.puts.length = 0;

    h.fireVisibility('hidden');
    await settle();

    expect(h.store.puts).toHaveLength(0);
  });

  it('ignores visibilitychange when the tab became VISIBLE', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    h.store.puts.length = 0;

    h.bus.emit('kf:change');
    h.fireVisibility('visible');
    await settle();

    expect(h.store.puts).toHaveLength(0);   // still only debounced
    await tick();
    expect(h.store.puts).toHaveLength(1);
  });

  it('flushes on beforeunload', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    h.store.puts.length = 0;

    h.io.setSnapshot('closing-edit');
    h.bus.emit('kf:change');
    h.fireBeforeUnload();
    await settle();

    expect(h.store.puts.map((p) => p.body)).toEqual(['closing-edit']);
  });

  it('requestFlush() is the same flush, exposed for the desktop shell', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    h.store.puts.length = 0;

    h.io.setSnapshot('hot-update');
    h.bus.emit('kf:change');
    await h.ctrl.requestFlush();

    expect(h.store.puts.map((p) => p.body)).toEqual(['hot-update']);
    await tick();
    expect(h.store.puts).toHaveLength(1);
  });

  it('requestFlush() with nothing dirty is a no-op', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    h.store.puts.length = 0;

    await h.ctrl.requestFlush();

    expect(h.store.puts).toHaveLength(0);
  });
});

describe('switchTo', () => {
  async function twoProjects(): Promise<Harness> {
    const h = makeHarness((s) => {
      s.metas.set('a', meta('a', 'Archer', 100));
      s.blobs.set('a', taggedBlob('archer-zip'));
      s.metas.set('b', meta('b', 'Brawler', 900));
      s.blobs.set('b', taggedBlob('brawler-zip'));
    });
    ls.set(LS_ACTIVE_KEY, 'a');
    await h.ctrl.bootstrap();
    h.store.puts.length = 0;
    h.events.length = 0;
    h.io.loads.length = 0;
    return h;
  }

  it('loads the target project, makes it active, and remembers it', async () => {
    const h = await twoProjects();

    await h.ctrl.switchTo('b');

    expect(h.io.loads).toEqual([{ body: 'brawler-zip', label: 'Brawler' }]);
    expect(h.ctrl.activeId).toBe('b');
    expect(h.ctrl.activeName).toBe('Brawler');
    expect(ls.get(LS_ACTIVE_KEY)).toBe('b');
    expect(h.events.map((e) => e.event)).toEqual(['project:active', 'autosave:state']);
    expect(h.events[h.events.length - 1]!.payload).toBe('saved');
  });

  it('persists pending edits to the project being LEFT before loading the new one', async () => {
    const h = await twoProjects();

    h.io.setSnapshot('archer-edited');
    h.bus.emit('kf:change');
    await h.ctrl.switchTo('b');

    expect(h.store.puts).toHaveLength(1);
    expect(h.store.puts[0]!.meta.id).toBe('a');
    expect(h.store.puts[0]!.body).toBe('archer-edited');
  });

  it('is a no-op when the target is already active', async () => {
    const h = await twoProjects();

    await h.ctrl.switchTo('a');

    expect(h.io.loads).toEqual([]);
    expect(h.events).toEqual([]);
  });

  // The state ProjectStore.putMeta() can legitimately produce: metadata with no blob.
  it('errors and stays put when the target has no blob', async () => {
    const h = await twoProjects();
    h.store.metas.set('ghost', meta('ghost', 'Ghost', 500));

    await h.ctrl.switchTo('ghost');

    expect(h.events).toEqual([{ event: 'error', payload: 'Project not found' }]);
    expect(h.ctrl.activeId).toBe('a');
    expect(h.io.loads).toEqual([]);
  });

  it('errors and stays put when the target has no metadata', async () => {
    const h = await twoProjects();
    h.store.blobs.set('orphan', taggedBlob('orphan-zip'));

    await h.ctrl.switchTo('orphan');

    expect(h.events).toEqual([{ event: 'error', payload: 'Project not found' }]);
    expect(h.ctrl.activeId).toBe('a');
  });

  // The `loading` guard is only OBSERVABLE when switching to an already-active-once project:
  // on the very first switch `currentId` is still null and scheduleSave() bails on that instead,
  // hiding the flag entirely. Same distinction vfx-editor's Library.test.ts had to make.
  it('the loaded project is not immediately dirty from its own load events', async () => {
    const h = await twoProjects();
    h.io.loadEditorBlob.mockImplementation(async () => { h.bus.emit('kf:change'); return true; });

    await h.ctrl.switchTo('b');
    await tick();

    expect(h.store.puts).toHaveLength(0);
    expect(h.events.filter((e) => e.event === 'autosave:state').map((e) => e.payload)).toEqual(['saved']);
  });
});

describe('createNew / duplicate', () => {
  it('createNew resets to defaults, saves under the new name, and switches to it', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    const firstId = h.ctrl.activeId;
    h.store.puts.length = 0;
    h.events.length = 0;

    h.io.setSnapshot('blank-character');
    await h.ctrl.createNew('Mage');

    expect(h.resets).toBe(2);
    expect(h.ctrl.activeName).toBe('Mage');
    expect(h.ctrl.activeId).not.toBe(firstId);
    expect(h.store.puts.map((p) => [p.meta.name, p.body])).toEqual([['Mage', 'blank-character']]);
    expect(h.store.metas.size).toBe(2);       // the old project survives
    expect(h.events.map((e) => e.event)).toEqual(['project:active', 'project:list']);
  });

  it('createNew flushes pending edits to the outgoing project first', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    const firstId = h.ctrl.activeId!;
    h.store.puts.length = 0;

    h.io.setSnapshot('unsaved');
    h.bus.emit('kf:change');
    await h.ctrl.createNew('Mage');

    expect(h.store.puts.map((p) => [p.meta.id, p.body])).toEqual([
      [firstId, 'unsaved'],
      [h.ctrl.activeId!, 'unsaved'],
    ]);
  });

  it('duplicate copies the current snapshot under a "… copy" name and switches to it', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    await h.ctrl.rename('Archer');
    const originalId = h.ctrl.activeId;
    h.store.puts.length = 0;
    h.events.length = 0;

    h.io.setSnapshot('archer-current');
    await h.ctrl.duplicate();

    expect(h.ctrl.activeName).toBe('Archer copy');
    expect(h.ctrl.activeId).not.toBe(originalId);
    expect(h.store.puts.map((p) => [p.meta.name, p.body])).toEqual([['Archer copy', 'archer-current']]);
    expect(h.resets).toBe(1);   // duplicate must NOT reset to defaults
    expect(h.store.metas.size).toBe(2);
  });

  it('duplicate does nothing with no project open', async () => {
    const h = makeHarness();
    await h.ctrl.duplicate();

    expect(h.store.puts).toHaveLength(0);
    expect(h.events).toEqual([]);
  });

  it('generated ids are distinct even without crypto.randomUUID', async () => {
    // genId() falls back to Date.now()+Math.random() when randomUUID is unavailable — and
    // Date.now() is frozen by the fake timers, so the random half is the only thing separating
    // two ids created in the same tick. That is exactly the case worth pinning.
    vi.stubGlobal('crypto', {});
    const h = makeHarness();
    await h.ctrl.bootstrap();
    const first = h.ctrl.activeId!;
    await h.ctrl.duplicate();
    const second = h.ctrl.activeId!;
    await h.ctrl.duplicate();

    expect(first).toMatch(/^p_/);
    expect(second).toMatch(/^p_/);
    expect(new Set([first, second, h.ctrl.activeId!]).size).toBe(3);
  });
});

describe('rename', () => {
  it('writes metadata only and re-announces the active project', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    const id = h.ctrl.activeId!;
    h.store.puts.length = 0;
    h.events.length = 0;
    vi.setSystemTime(new Date('2026-08-20T14:00:00Z'));

    await h.ctrl.rename('Archer');

    expect(h.ctrl.activeName).toBe('Archer');
    expect(h.store.metas.get(id)).toEqual({ id, name: 'Archer', updatedAt: Date.now() });
    expect(h.store.puts).toHaveLength(0);   // putMeta, not put — the blob is untouched
    expect(h.events).toEqual([
      { event: 'project:active', payload: { id, name: 'Archer' } },
      { event: 'project:list', payload: undefined },
    ]);
  });

  it('refuses an empty name and does nothing with no project open', async () => {
    const h = makeHarness();
    await h.ctrl.rename('Orphan');       // nothing open
    expect(h.events).toEqual([]);

    await h.ctrl.bootstrap();
    h.events.length = 0;
    await h.ctrl.rename('');
    expect(h.ctrl.activeName).toBe('Untitled');
    expect(h.events).toEqual([]);
  });

  it('the renamed project keeps its new name in the next auto-save', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    await h.ctrl.rename('Archer');
    h.store.puts.length = 0;

    h.bus.emit('kf:change');
    await tick();

    expect(h.store.puts[0]!.meta.name).toBe('Archer');
  });
});

describe('remove', () => {
  it('deletes the active project and switches to the most recent survivor', async () => {
    const h = makeHarness((s) => {
      s.metas.set('a', meta('a', 'Archer', 100));
      s.blobs.set('a', taggedBlob('archer-zip'));
      s.metas.set('b', meta('b', 'Brawler', 900));
      s.blobs.set('b', taggedBlob('brawler-zip'));
    });
    ls.set(LS_ACTIVE_KEY, 'a');
    await h.ctrl.bootstrap();
    h.events.length = 0;
    h.io.loads.length = 0;

    await h.ctrl.remove();

    expect(h.store.metas.has('a')).toBe(false);
    expect(h.store.blobs.has('a')).toBe(false);
    expect(h.ctrl.activeId).toBe('b');
    expect(h.io.loads).toEqual([{ body: 'brawler-zip', label: 'Brawler' }]);
    expect(h.events[h.events.length - 1]!.event).toBe('project:list');
  });

  it('deleting the last project resets to defaults and starts a fresh Untitled', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    const firstId = h.ctrl.activeId!;
    h.store.puts.length = 0;

    h.io.setSnapshot('fresh-default');
    await h.ctrl.remove();

    expect(h.store.metas.has(firstId)).toBe(false);
    expect(h.resets).toBe(2);
    expect(h.ctrl.activeName).toBe('Untitled');
    expect(h.ctrl.activeId).not.toBe(firstId);
    expect(h.store.puts.map((p) => [p.meta.name, p.body])).toEqual([['Untitled', 'fresh-default']]);
  });

  // The pending debounce belongs to the project being deleted. Letting it fire would resurrect
  // the record that was just removed.
  it('drops the pending save for the project being deleted instead of resurrecting it', async () => {
    const h = makeHarness();
    await h.ctrl.bootstrap();
    const doomedId = h.ctrl.activeId!;
    h.store.puts.length = 0;

    h.bus.emit('kf:change');           // save scheduled for the doomed project
    expect(vi.getTimerCount()).toBe(1);
    await h.ctrl.remove();

    // The timer is gone, not just defused. remove() ends by adopting a fresh project, and
    // setActive() clears `dirty` on the way — so a surviving timer would fire into a no-op and the
    // write log would look the same. Deleting remove()'s clearTimeout left this test green until
    // the timer count was asserted; the source line is only observable here.
    expect(vi.getTimerCount()).toBe(0);

    await tick(DEBOUNCE_MS * 2);
    expect(h.store.puts.some((p) => p.meta.id === doomedId)).toBe(false);
    expect(h.store.metas.has(doomedId)).toBe(false);
  });

  it('does nothing with no project open', async () => {
    const h = makeHarness();
    await h.ctrl.remove();

    expect(h.events).toEqual([]);
    expect(h.store.puts).toHaveLength(0);
  });
});

describe('DIRTY_EVENTS', () => {
  // Exported so the auto-save trigger set is one definition rather than two. Pin the membership:
  // the point of the list is that content-changing events are in it and view-only ones are not.
  it('covers every content-changing event and no view-only ones', () => {
    expect([...DIRTY_EVENTS].sort()).toEqual([
      'anim:list', 'attachment:change', 'binding:change', 'images:change', 'kf:change', 'rig:change',
    ]);
    for (const viewOnly of ['time:change', 'play:state', 'bone:select', 'anim:select', 'preview:mode', 'editor:mode', 'status', 'error']) {
      expect(DIRTY_EVENTS).not.toContain(viewOnly);
    }
  });
});
