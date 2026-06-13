// ReplayStore (S1-RP) — local ring of recent recorded matches.
import { describe, it, expect } from 'vitest';
import { ReplayStore, MAX_REPLAYS, REPLAY_STORAGE_KEY } from '../src/game/meta/ReplayStore';
import { ENGINE_VERSION } from '../src/game/types';
import type { Replay } from '../src/game/types';
import type { IStorage } from '../src/platform/IPlatform';

function memStorage(): IStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function makeReplay(seed: number, levelId?: string, winner = 0): Replay {
  return {
    engineVersion: ENGINE_VERSION,
    mode: levelId ? 'campaign' : 'pvp',
    seed,
    frames: [{ tick: 3, commands: [{ type: 'play_card', owner: 0, tick: 3, handIndex: 0, col: 1 }] }],
    endFrame: 10,
    meta: { recordedAt: 1000 + seed, winner, ...(levelId ? { levelId } : {}) },
  };
}

describe('ReplayStore', () => {
  it('returns empty / null when nothing is stored', () => {
    const store = new ReplayStore(memStorage());
    expect(store.list()).toEqual([]);
    expect(store.latest()).toBeNull();
    expect(store.load('nope')).toBeNull();
  });

  it('saves and loads a replay round-trip; latest() is the most recent', () => {
    const store = new ReplayStore(memStorage());
    const idA = store.save(makeReplay(1), 1001);
    const idB = store.save(makeReplay(2), 1002);
    expect(idA).not.toBe(idB);
    expect(store.load(idA)!.seed).toBe(1);
    expect(store.latest()!.seed).toBe(2);
  });

  it('lists entries newest-first with summary metadata (no full streams)', () => {
    const store = new ReplayStore(memStorage());
    store.save(makeReplay(1, 'ch1_lv1', 0), 1001);
    store.save(makeReplay(2, undefined, 1), 1002);
    const list = store.list();
    expect(list.map((e) => e.recordedAt)).toEqual([1002, 1001]); // newest first
    expect(list[0]).toMatchObject({ mode: 'pvp', winner: 1 });
    expect(list[1]).toMatchObject({ mode: 'campaign', levelId: 'ch1_lv1', winner: 0 });
    expect(list[0]).not.toHaveProperty('replay'); // index rows are light
  });

  it('evicts the oldest beyond MAX_REPLAYS (ring buffer)', () => {
    const store = new ReplayStore(memStorage());
    for (let i = 0; i < MAX_REPLAYS + 5; i++) store.save(makeReplay(i), 2000 + i);
    const list = store.list();
    expect(list).toHaveLength(MAX_REPLAYS);
    // The 5 oldest were dropped; newest retained.
    expect(list[0]!.recordedAt).toBe(2000 + MAX_REPLAYS + 4);
    expect(store.latest()!.seed).toBe(MAX_REPLAYS + 4);
  });

  it('survives a corrupt storage payload (treats as empty)', () => {
    const storage = memStorage();
    storage.setItem(REPLAY_STORAGE_KEY, '{ not json');
    const store = new ReplayStore(storage);
    expect(store.list()).toEqual([]);
    const id = store.save(makeReplay(7), 3000);
    expect(store.load(id)!.seed).toBe(7);
  });

  it('persists JSON to the shared storage key', () => {
    const storage = memStorage();
    new ReplayStore(storage).save(makeReplay(9), 4000);
    expect(storage.map.has(REPLAY_STORAGE_KEY)).toBe(true);
    // Re-reading through a fresh store sees the same data.
    expect(new ReplayStore(storage).latest()!.seed).toBe(9);
  });
});
