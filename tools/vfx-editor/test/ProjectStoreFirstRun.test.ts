// ProjectStore's FIRST-RUN path (src/io/ProjectStore.ts) — the `onupgradeneeded` handler that
// creates the 'effects' object store.
//
// Why a separate file: ProjectStore.test.ts resets state in `beforeEach` by opening its own raw
// connection (deleteDatabase hangs against ProjectStore's never-closed connections — see that
// file's header), and that raw connection is what creates the db and the object store. So by the
// time the class under test opens it, the store already exists and its own upgrade path never
// runs — the one path a brand-new browser profile always takes was the only one no test took.
// Vitest isolates test files, and `fake-indexeddb/auto` therefore installs a fresh, empty
// IndexedDB here, which is exactly the precondition this needs.
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { EffectDef } from '@vfx/types';
import { ProjectStore } from '../src/io/ProjectStore';

function makeDef(id: string): EffectDef {
  return { id, duration: 1, layers: [{ type: 'ring' }] };
}

describe('first run against a database that does not exist yet', () => {
  it('creates the object store itself, so the very first read and write both work', async () => {
    // Load-bearing precondition, asserted rather than assumed: if file isolation is ever turned
    // off, another file's raw connection will have created the db already and this test would go
    // on passing while proving nothing.
    expect(
      await indexedDB.databases(),
      'the nw-vfx db already exists — test-file isolation is off, so this no longer covers onupgradeneeded',
    ).toEqual([]);

    const store = new ProjectStore();
    // count() is the call Library.bootstrap() makes first on a cold start; without the upgrade
    // handler creating 'effects', the transaction here throws NotFoundError instead.
    expect(await store.count()).toBe(0);
    await store.put({ id: 'e1', def: makeDef('e1'), updatedAt: 1 });
    expect((await store.get('e1'))!.def.id).toBe('e1');
    expect(await store.count()).toBe(1);
  });
});
