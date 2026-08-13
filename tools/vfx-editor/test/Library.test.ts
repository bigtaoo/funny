// Library (src/io/Library.ts) — owns the effect library's active selection + debounced autosave.
// Drives a REAL EffectModel (already covered on its own in EffectModel.test.ts). The one
// deliberate stand-in is the store: Library's autosave debounce timing needs `vi.useFakeTimers()`
// to test without real 1.2s waits, but combining fake timers with the real `fake-indexeddb`-backed
// ProjectStore hangs (its internal async simulation is itself timer-based — repro'd standalone
// before writing this file; ProjectStore's OWN correctness against real IndexedDB is already
// covered for real in ProjectStore.test.ts). So this file uses a minimal in-memory FakeStore that
// implements ProjectStore's exact public shape (list/get/put/delete/count) — same spirit as
// animator's editorProject.test.ts hand-rolling only the one dependency (ImageController) that's
// infeasible to run for real, keeping everything else (the model, the Library logic under test)
// real. `window`/`document`/`localStorage` are stubbed per the vi.stubGlobal idiom established in
// animator/test/fileIO.test.ts — stubbed in beforeEach, BEFORE any `new Library(...)`, since its
// constructor calls window.addEventListener/document.addEventListener immediately.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EffectDef } from '@vfx/types';
import { EffectModel } from '../src/model/EffectModel';
import { Library } from '../src/io/Library';
import type { EffectRecord, ProjectStore } from '../src/io/ProjectStore';

class FakeStore {
  records = new Map<string, EffectRecord>();
  async list(): Promise<EffectRecord[]> {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(id: string): Promise<EffectRecord | undefined> { return this.records.get(id); }
  async put(rec: EffectRecord): Promise<void> { this.records.set(rec.id, { ...rec, def: JSON.parse(JSON.stringify(rec.def)) }); }
  async delete(id: string): Promise<void> { this.records.delete(id); }
  async count(): Promise<number> { return this.records.size; }
}

function makeDef(id: string): EffectDef { return { id, duration: 1, layers: [] }; }

function makeEnv() {
  const windowListeners: Record<string, Array<() => void>> = {};
  const documentListeners: Record<string, Array<() => void>> = {};
  const localStorageMap = new Map<string, string>();
  vi.stubGlobal('window', {
    addEventListener: (ev: string, fn: () => void) => { (windowListeners[ev] ??= []).push(fn); },
    // A wrapper (not a captured reference) so it always resolves `setTimeout` through whatever is
    // globally bound at call time — safe regardless of when fake timers get enabled relative to this stub.
    setTimeout: (...args: unknown[]) => (setTimeout as (...a: unknown[]) => number)(...args),
  });
  const fakeDocument = {
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener: (ev: string, fn: () => void) => { (documentListeners[ev] ??= []).push(fn); },
  };
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (localStorageMap.has(k) ? localStorageMap.get(k)! : null),
    setItem: (k: string, v: string) => { localStorageMap.set(k, v); },
  });
  return { windowListeners, documentListeners, fakeDocument, localStorageMap };
}

/** Advance the debounce timer AND drain the microtask queue so awaited store I/O resolves too. */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

let env: ReturnType<typeof makeEnv>;

beforeEach(() => {
  vi.useFakeTimers();
  env = makeEnv(); // must exist before any `new Library(...)` — its constructor touches window/document immediately
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeLibrary(store: FakeStore, builtins: EffectDef[] = []) {
  const model = new EffectModel(makeDef('unloaded'));
  const onAutosave = vi.fn();
  const onListChange = vi.fn();
  const lib = new Library(store as unknown as ProjectStore, model, builtins, onAutosave, onListChange);
  return { lib, model, onAutosave, onListChange };
}

describe('bootstrap', () => {
  it('seeds the builtins into an empty store, then picks the first (no lastId) and notifies', async () => {
    const store = new FakeStore();
    const { lib, model, onListChange } = makeLibrary(store, [makeDef('idleFx'), makeDef('hitFx')]);
    await lib.bootstrap();
    expect(await store.count()).toBe(2);
    expect(lib.activeId).not.toBeNull();
    expect(['builtin:idleFx', 'builtin:hitFx']).toContain(lib.activeId);
    expect(model.effect.id).toBe((await store.get(lib.activeId!))!.def.id);
    expect(onListChange).toHaveBeenCalled();
  });

  it('does NOT reseed builtins when the store already has records', async () => {
    const store = new FakeStore();
    await store.put({ id: 'existing', def: makeDef('existing'), updatedAt: 1 });
    const { lib } = makeLibrary(store, [makeDef('idleFx'), makeDef('hitFx')]);
    await lib.bootstrap();
    expect(await store.count()).toBe(1); // still just the pre-existing one, no builtins added
  });

  it('restores the exact lastId from localStorage when it is present in the list', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 100 });
    await store.put({ id: 'b', def: makeDef('b'), updatedAt: 200 }); // newest — would win the no-lastId fallback
    env.localStorageMap.set('nw-vfx:activeId', 'a');
    const { lib, model } = makeLibrary(store);
    await lib.bootstrap();
    expect(lib.activeId).toBe('a');
    expect(model.effect.id).toBe('a');
  });

  it('falls back to the most-recently-updated record when lastId is unset or stale', async () => {
    const store = new FakeStore();
    await store.put({ id: 'old', def: makeDef('old'), updatedAt: 100 });
    await store.put({ id: 'newest', def: makeDef('newest'), updatedAt: 300 });
    env.localStorageMap.set('nw-vfx:activeId', 'does-not-exist');
    const { lib, model } = makeLibrary(store);
    await lib.bootstrap();
    expect(lib.activeId).toBe('newest');
    expect(model.effect.id).toBe('newest');
  });

  it('list() delegates straight to the store', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    const { lib } = makeLibrary(store);
    expect((await lib.list()).map((r) => r.id)).toEqual(['a']);
  });
});

describe('switchTo', () => {
  it('loads the target fresh, sets activeId, persists it to localStorage, and reports saved', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    await store.put({ id: 'b', def: makeDef('b'), updatedAt: 2 });
    const { lib, model, onAutosave } = makeLibrary(store);
    await lib.switchTo('a');
    expect(lib.activeId).toBe('a');
    expect(model.effect.id).toBe('a');
    expect(env.localStorageMap.get('nw-vfx:activeId')).toBe('a');
    expect(onAutosave).toHaveBeenCalledWith('saved');
  });

  it('re-switching to the already-active id is a silent no-op', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    const { lib, onAutosave } = makeLibrary(store);
    await lib.switchTo('a');
    onAutosave.mockClear();
    await lib.switchTo('a');
    expect(onAutosave).not.toHaveBeenCalled();
  });

  it('switching to a nonexistent id leaves the current selection untouched', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    const { lib, model } = makeLibrary(store);
    await lib.switchTo('a');
    await lib.switchTo('does-not-exist');
    expect(lib.activeId).toBe('a');
    expect(model.effect.id).toBe('a');
  });

  it('flushes a pending dirty edit on the outgoing project before switching away', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    await store.put({ id: 'b', def: makeDef('b'), updatedAt: 2 });
    const { lib, model } = makeLibrary(store);
    await lib.switchTo('a');
    model.setDefaultColor('#ff0000'); // dirties 'a', debounce not yet fired
    await lib.switchTo('b'); // must flush 'a' first
    expect((await store.get('a'))!.def.defaultColor).toBe('#ff0000');
    expect(lib.activeId).toBe('b');
  });
});

describe('createNew / duplicateActive / removeActive', () => {
  it('createNew generates an id, stores it, becomes active, and notifies the list', async () => {
    const store = new FakeStore();
    const { lib, model, onListChange } = makeLibrary(store);
    await lib.createNew(makeDef('brand-new'));
    expect(model.effect.id).toBe('brand-new');
    expect(lib.activeId).not.toBeNull();
    expect((await store.get(lib.activeId!))!.def.id).toBe('brand-new');
    expect(onListChange).toHaveBeenCalled();
  });

  it('duplicateActive clones the current effect with a "_copy" id suffix as a new active project', async () => {
    const store = new FakeStore();
    const { lib, model } = makeLibrary(store);
    await lib.createNew(makeDef('orig'));
    const originalId = lib.activeId!;
    await lib.duplicateActive();
    expect(model.effect.id).toBe('orig_copy');
    expect(lib.activeId).not.toBe(originalId);
    expect((await store.get(originalId))!.def.id).toBe('orig'); // original left untouched
  });

  it('duplicateActive is a no-op when nothing is active yet', async () => {
    const store = new FakeStore();
    const { lib } = makeLibrary(store);
    await lib.duplicateActive();
    expect(await store.count()).toBe(0);
  });

  it('removeActive deletes the current record and switches to the next remaining one', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    await store.put({ id: 'b', def: makeDef('b'), updatedAt: 2 });
    const { lib, model, onListChange } = makeLibrary(store);
    await lib.switchTo('a');
    await lib.removeActive();
    expect(await store.get('a')).toBeUndefined();
    expect(lib.activeId).toBe('b');
    expect(model.effect.id).toBe('b');
    expect(onListChange).toHaveBeenCalled();
  });

  it('removeActive on the last project leaves the library with no active selection', async () => {
    const store = new FakeStore();
    await store.put({ id: 'only', def: makeDef('only'), updatedAt: 1 });
    const { lib } = makeLibrary(store);
    await lib.switchTo('only');
    await lib.removeActive();
    expect(lib.activeId).toBeNull();
    expect(await store.count()).toBe(0);
  });

  it('removeActive is a no-op when nothing is active', async () => {
    const store = new FakeStore();
    const { lib, onListChange } = makeLibrary(store);
    await lib.removeActive();
    expect(onListChange).not.toHaveBeenCalled();
  });

  it('removeActive cancels a pending debounced save for the project being removed', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    const { lib, model } = makeLibrary(store);
    await lib.switchTo('a');
    model.setDefaultColor('#00ff00'); // schedules a debounced save, not yet fired
    await lib.removeActive();
    await tick(5000); // well past DEBOUNCE_MS — the cancelled timer must never fire a stale save
    expect(await store.get('a')).toBeUndefined();
  });
});

describe('autosave debounce', () => {
  it('loading a project via switchTo/createNew never itself marks the project dirty (suspended guard)', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    const { lib, onAutosave } = makeLibrary(store);
    await lib.switchTo('a');
    expect(onAutosave).not.toHaveBeenCalledWith('dirty');
  });

  it('switching AWAY from an already-active project also never marks it dirty, and never corrupts it with the incoming def', async () => {
    // Unlike the first switchTo (currentId starts null, so the "!currentId" guard alone would hide
    // a missing `suspended` flag), this second switchTo has currentId already set to 'a' at the
    // moment loadFresh('b') fires its emit — only the `suspended` flag stops that emit from
    // scheduling a save that would otherwise overwrite 'a' in the store with 'b's content.
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    await store.put({ id: 'b', def: makeDef('b'), updatedAt: 2 });
    const { lib, onAutosave } = makeLibrary(store);
    await lib.switchTo('a');
    onAutosave.mockClear();
    await lib.switchTo('b');
    expect(onAutosave).not.toHaveBeenCalledWith('dirty');
    await tick(5000); // even past the debounce window, nothing should ever have been scheduled
    expect((await store.get('a'))!.def.id).toBe('a'); // not corrupted with 'b's content
  });

  it('a real edit marks dirty immediately, then flushes to the store after the debounce window', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    const { lib, model, onAutosave, onListChange } = makeLibrary(store);
    await lib.switchTo('a');
    onAutosave.mockClear();
    model.setDefaultColor('#123456');
    expect(onAutosave).toHaveBeenCalledWith('dirty');
    expect((await store.get('a'))!.def.defaultColor).toBeUndefined(); // not yet flushed

    await tick(1200);
    expect(onAutosave).toHaveBeenCalledWith('saving');
    expect(onAutosave).toHaveBeenLastCalledWith('saved');
    expect((await store.get('a'))!.def.defaultColor).toBe('#123456');
    expect(onListChange).toHaveBeenCalled();
  });

  it('rapid consecutive edits collapse into exactly one flush, persisting only the final value', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    const { lib, model, onAutosave } = makeLibrary(store);
    await lib.switchTo('a');
    model.setId('edit-1');
    await tick(600); // under the 1200ms debounce
    model.setId('edit-2'); // reschedules — the pending flush must NOT have fired yet
    await tick(1200);
    expect(onAutosave.mock.calls.filter((c) => c[0] === 'saving')).toHaveLength(1);
    expect((await store.get('a'))!.def.id).toBe('edit-2');
  });

  it('a second edit within the debounce window explicitly cancels the first edit\'s pending timer', async () => {
    // The "collapses to one flush" test above passes even without this cancellation (flush()'s
    // own `!dirty` guard happens to absorb a redundant fire too) — this test pins the actual
    // cancel-and-reschedule mechanism directly, via a spy on the real (fake-timers-patched) global.
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    const { lib, model } = makeLibrary(store);
    await lib.switchTo('a');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    model.setId('edit-1'); // first scheduleSave — no prior timer, clearTimeout not called yet
    expect(clearSpy).not.toHaveBeenCalled();
    model.setId('edit-2'); // second scheduleSave — must cancel edit-1's pending timer first
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('scheduleSave is a no-op while nothing is active (model events before any switchTo/createNew)', () => {
    const store = new FakeStore();
    const { model, onAutosave } = makeLibrary(store);
    model.setDefaultColor('#ffffff');
    expect(onAutosave).not.toHaveBeenCalled();
  });
});

describe('best-effort flush on tab hide / close', () => {
  it('the visibilitychange listener flushes a pending dirty edit when the tab becomes hidden', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    const { lib, model } = makeLibrary(store);
    await lib.switchTo('a');
    model.setDefaultColor('#abcabc');
    env.fakeDocument.visibilityState = 'hidden';
    env.documentListeners['visibilitychange']!.forEach((fn) => fn());
    await tick(0); // drains the microtask-only store.put — no real timer involved in the flush itself
    expect((await store.get('a'))!.def.defaultColor).toBe('#abcabc');
  });

  it('the visibilitychange listener does nothing when the tab is still visible', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    const { lib, model } = makeLibrary(store);
    await lib.switchTo('a');
    model.setDefaultColor('#abcabc');
    // visibilityState stays 'visible' — the handler's own guard must skip the flush.
    env.documentListeners['visibilitychange']!.forEach((fn) => fn());
    await tick(0);
    expect((await store.get('a'))!.def.defaultColor).toBeUndefined();
  });

  it('the beforeunload listener flushes a pending dirty edit unconditionally', async () => {
    const store = new FakeStore();
    await store.put({ id: 'a', def: makeDef('a'), updatedAt: 1 });
    const { lib, model } = makeLibrary(store);
    await lib.switchTo('a');
    model.setDefaultColor('#123123');
    env.windowListeners['beforeunload']!.forEach((fn) => fn());
    await tick(0);
    expect((await store.get('a'))!.def.defaultColor).toBe('#123123');
  });
});
