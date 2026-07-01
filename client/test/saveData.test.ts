import { describe, it, expect } from 'vitest';
import {
  makeNewSave,
  migrate,
  SAVE_VERSION,
  SAVE_STORAGE_KEY,
  extractSyncPatch,
} from '../src/game/meta';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import type { IStorage } from '../src/platform/IPlatform';

/** In-memory IStorage (test double). */
class MemStorage implements IStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

describe('SaveData migrate (S0-2)', () => {
  it('null / non-object → fresh save', () => {
    expect(migrate(null)).toEqual(makeNewSave());
    expect(migrate(undefined)).toEqual(makeNewSave());
    expect(migrate(42)).toEqual(makeNewSave());
  });

  it('partial object is filled up to the current version while preserving existing fields', () => {
    const raw = { progress: { cleared: ['ch1_lv1'] } };
    const s = migrate(raw);
    expect(s.version).toBe(SAVE_VERSION);
    expect(s.progress.cleared).toEqual(['ch1_lv1']);
    // missing sub-fields are filled in
    expect(s.progress.stars).toEqual({});
    expect(s.wallet).toEqual({ coins: 0 });
    expect(s.pvp.elo).toBe(1000);
  });

  it('v0 (no version field) upgrades to v1', () => {
    const raw = { wallet: { coins: 7 }, materials: { wood: 3 } };
    const s = migrate(raw);
    expect(s.version).toBe(SAVE_VERSION);
    expect(s.wallet.coins).toBe(7);
    expect(s.materials.wood).toBe(3);
  });

  it('dynamic keys (best / flags custom entries) are preserved', () => {
    const raw = {
      version: 1,
      progress: { cleared: [], stars: {}, best: { ch1_lv2: { timeMs: 1234 } } },
      flags: { custom_flag: true },
    };
    const s = migrate(raw);
    expect(s.progress.best.ch1_lv2).toEqual({ timeMs: 1234 });
    expect(s.flags.custom_flag).toBe(true);
  });

  it('migration is idempotent: migrate(migrate(x)) === migrate(x)', () => {
    const once = migrate({ progress: { cleared: ['a'] } });
    expect(migrate(once)).toEqual(once);
  });
});

describe('LocalSaveStore round-trip (S0-3)', () => {
  it('saveLocal → loadLocal round-trip is consistent', () => {
    const store = new LocalSaveStore(new MemStorage());
    const s = makeNewSave('acc-1', 100);
    s.materials.iron = 5;
    s.progress.cleared.push('ch1_lv1');
    store.saveLocal(s);
    expect(store.loadLocal()).toEqual(s);
  });

  it('empty storage → fresh save', () => {
    const store = new LocalSaveStore(new MemStorage());
    expect(store.loadLocal()).toEqual(makeNewSave());
  });

  it('corrupt JSON → falls back to a fresh save (no throw)', () => {
    const mem = new MemStorage();
    mem.setItem(SAVE_STORAGE_KEY, '{not valid json');
    const store = new LocalSaveStore(mem);
    expect(store.loadLocal()).toEqual(makeNewSave());
  });

  it('absorbs legacy nw_seen_intro → flags.seen_intro', () => {
    const mem = new MemStorage();
    mem.setItem('nw_seen_intro', '1');
    const store = new LocalSaveStore(mem);
    expect(store.loadLocal().flags.seen_intro).toBe(true);
  });

  it('existing flags.seen_intro is not overwritten by the legacy key', () => {
    const mem = new MemStorage();
    mem.setItem('nw_seen_intro', '1');
    const store = new LocalSaveStore(mem);
    const s = makeNewSave();
    s.flags.seen_intro = false;
    store.saveLocal(s);
    expect(store.loadLocal().flags.seen_intro).toBe(false);
  });
});

describe('extractSyncPatch (S0-1 / PvE server-authoritative §8)', () => {
  it('narrowed to equipped/flags only (progress/materials/pveUpgrades are server-authoritative and no longer uploaded)', () => {
    const patch = extractSyncPatch(makeNewSave());
    expect(Object.keys(patch).sort()).toEqual(['equipped', 'flags'].sort());
    // authoritative sections are never uploaded
    expect('wallet' in patch).toBe(false);
    expect('pvp' in patch).toBe(false);
    // From §8 onward these three sections are also server-authoritative (written only by /pve/*); PUT /save rejects them
    expect('progress' in patch).toBe(false);
    expect('materials' in patch).toBe(false);
    expect('pveUpgrades' in patch).toBe(false);
  });
});
