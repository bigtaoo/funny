// SaveManager unit tests.
//  · refresh() (S1-R): after the server authoritatively updates the ranked stats (pvp) at match end, client pull + reconcile reflects them immediately.
//  · PvE server authority (PVE_INTEGRITY_PLAN §8): progress/materials/pveUpgrades are taken from the cloud (no more union/max merge);
//    level clear / upgrade go through /pve/* endpoints; offline clears are queued and flushed on reconnect.
import { describe, it, expect } from 'vitest';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { makeNewSave, type SaveData } from '../src/game/meta';
import { ApiError, type ApiClient } from '../src/net/ApiClient';
import type { IStorage } from '../src/platform/IPlatform';

class MemStorage implements IStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

function fakeApi(cloud: SaveData, hasToken = true, displayName?: string): ApiClient {
  return {
    hasToken: () => hasToken,
    getSave: async () => ({ save: cloud, displayName }),
  } as unknown as ApiClient;
}

describe('SaveManager.refresh (S1-R)', () => {
  it('cloud authoritative pvp overwrites local (rank refreshed immediately)', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1)); // local is still initial unranked/1000
    const cloud = makeNewSave('a', 1);
    cloud.pvp = { elo: 1240, rank: 'gold', wins: 12, losses: 5, streak: 3 };

    const mgr = new SaveManager({ store, api: fakeApi(cloud) });
    expect(mgr.get().pvp.rank).toBe('unranked');

    const ok = await mgr.refresh();
    expect(ok).toBe(true);
    expect(mgr.get().pvp.rank).toBe('gold');
    expect(mgr.get().pvp.elo).toBe(1240);
    // persisted locally — next loadLocal also returns the new value
    expect(store.loadLocal().pvp.rank).toBe('gold');
  });

  it('progress/materials taken from cloud (§8 server authority, no more union/max merge)', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const local = makeNewSave('a', 1);
    local.progress.cleared.push('ch1_lv1'); // local-only (not yet settled by the server)
    local.materials = { scrap: 99 };
    store.saveLocal(local);

    const cloud = makeNewSave('a', 1);
    cloud.progress.cleared = ['ch1_lv2'];
    cloud.materials = { scrap: 3 };
    const mgr = new SaveManager({ store, api: fakeApi(cloud) });
    await mgr.refresh();
    // Cloud authority fully overwrites: local-only ch1_lv1 / scrap:99 are not preserved
    expect(mgr.get().progress.cleared).toEqual(['ch1_lv2']);
    expect(mgr.get().materials).toEqual({ scrap: 3 });
  });

  it('equipped/flags remain client-synced (local overrides cloud)', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const local = makeNewSave('a', 1);
    local.equipped = { skin: 'local_skin' };
    local.flags = { seen_intro: true };
    store.saveLocal(local);

    const cloud = makeNewSave('a', 1);
    cloud.equipped = { skin: 'cloud_skin' };
    const mgr = new SaveManager({ store, api: fakeApi(cloud) });
    await mgr.refresh();
    expect(mgr.get().equipped.skin).toBe('local_skin'); // local overrides cloud
    expect(mgr.get().flags.seen_intro).toBe(true);
  });

  it('not connected (no token) → no-op, returns false', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const mgr = new SaveManager({ store, api: fakeApi(makeNewSave('a', 1), false) });
    expect(await mgr.refresh()).toBe(false);
  });

  it('no api → false', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const mgr = new SaveManager({ store });
    expect(await mgr.refresh()).toBe(false);
  });

  it('refresh returns displayName → onProfile callback (restores display name on token re-login)', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1));
    let seen: string | undefined = 'unset';
    const mgr = new SaveManager({
      store,
      api: fakeApi(makeNewSave('a', 1), true, 'Frank'),
      onProfile: (p) => { seen = p.displayName; },
    });
    await mgr.refresh();
    expect(seen).toBe('Frank');
  });
});

describe('SaveManager.adoptSession (SA-3/SA-4 session adoption)', () => {
  it('after login, adopt accountId + pull/reconcile: authoritative data (including progress) taken from cloud', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const local = makeNewSave('local-anon', 1); // offline anonymous save
    local.progress.cleared.push('ch1_lv1');
    store.saveLocal(local);

    const cloud = makeNewSave('real-123', 5); // cloud real account with existing authoritative rank
    cloud.pvp = { elo: 1300, rank: 'gold', wins: 9, losses: 2, streak: 2 };
    cloud.wallet.coins = 500;
    cloud.progress.cleared = ['ch1_lv1', 'ch1_lv2'];

    const mgr = new SaveManager({ store, api: fakeApi(cloud) });
    const ok = await mgr.adoptSession('real-123');

    expect(ok).toBe(true);
    expect(mgr.get().accountId).toBe('real-123');
    expect(mgr.get().wallet.coins).toBe(500);
    expect(mgr.get().pvp.rank).toBe('gold');
    // progress is server-authoritative → taken from cloud (locally unsettled progress is not merged in)
    expect(mgr.get().progress.cleared).toEqual(['ch1_lv1', 'ch1_lv2']);
  });

  it('no token (pull fails) → accountId is still written but returns false', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('local-anon', 1));
    const mgr = new SaveManager({ store, api: fakeApi(makeNewSave('x', 1), false) });
    expect(await mgr.adoptSession('real-123')).toBe(false);
    expect(mgr.get().accountId).toBe('real-123');
  });
});

// ── PvE server authority: clear / upgrade / offline queue (§8) ──────────────────────────
describe('SaveManager.recordClear / upgrade / pending (§8)', () => {
  /** Records pveClear/pveUpgrade calls and optionally pushes back an authoritative save. */
  function pveApi(opts: {
    hasToken?: boolean;
    onClear?: (levelId: string, stars: number) => SaveData | Error;
    onUpgrade?: (id: string) => SaveData | Error;
  }) {
    const calls: { clears: Array<{ levelId: string; stars: number }>; upgrades: string[] } = {
      clears: [], upgrades: [],
    };
    const api = {
      hasToken: () => opts.hasToken ?? true,
      getSave: async () => ({ save: makeNewSave('a', 1) }),
      pveClear: async (levelId: string, stars: number) => {
        calls.clears.push({ levelId, stars });
        const r = opts.onClear?.(levelId, stars) ?? makeNewSave('a', 1);
        if (r instanceof Error) throw r;
        return { save: r, granted: {}, capped: false };
      },
      pveUpgrade: async (id: string) => {
        calls.upgrades.push(id);
        const r = opts.onUpgrade?.(id) ?? makeNewSave('a', 1);
        if (r instanceof Error) throw r;
        return { save: r };
      },
    } as unknown as ApiClient;
    return { api, calls };
  }

  it('online clear → POST /pve/clear and adopt pushed-back save (progress taken from server)', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1));
    const cloud = makeNewSave('a', 2);
    cloud.progress.cleared = ['ch1_lv1'];
    cloud.progress.stars = { ch1_lv1: 2 };
    cloud.materials = { scrap: 6 };
    const { api, calls } = pveApi({ onClear: () => cloud });

    const mgr = new SaveManager({ store, api });
    await mgr.recordClear('ch1_lv1', 2);

    expect(calls.clears).toEqual([{ levelId: 'ch1_lv1', stars: 2 }]);
    expect(mgr.get().progress.cleared).toEqual(['ch1_lv1']);
    expect(mgr.get().materials).toEqual({ scrap: 6 });
    expect(mgr.getPendingClears()).toEqual([]); // successful online clear is not queued
  });

  it('0 stars are not settled (level not cleared)', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const { api, calls } = pveApi({});
    const mgr = new SaveManager({ store, api });
    await mgr.recordClear('ch1_lv1', 0);
    expect(calls.clears).toEqual([]);
  });

  it('offline clear → queued for settlement + optimistic local unlock (no endpoint called), persisted locally', async () => {
    const mem = new MemStorage();
    const store = new LocalSaveStore(mem);
    store.saveLocal(makeNewSave('a', 1));
    const { api, calls } = pveApi({ hasToken: false });
    const mgr = new SaveManager({ store, api });

    await mgr.recordClear('ch1_lv1', 3);
    expect(calls.clears).toEqual([]); // offline: no request sent
    expect(mgr.getPendingClears().map((p) => p.levelId)).toEqual(['ch1_lv1']);
    // Optimistic local unlock (§8.4): clear is written to local progress immediately so the next level is unlocked when returning to CampaignMap;
    // materials still await server settlement. After reconcile/flush, cloud cleared overwrites the local value entirely.
    expect(mgr.get().progress.cleared).toEqual(['ch1_lv1']);
    expect(mgr.get().progress.stars).toEqual({ ch1_lv1: 3 });
    // Persistence: a new instance restores the queue + optimistic progress from storage
    const mgr2 = new SaveManager({ store, api });
    expect(mgr2.getPendingClears().map((p) => p.levelId)).toEqual(['ch1_lv1']);
    expect(mgr2.get().progress.cleared).toEqual(['ch1_lv1']);
  });

  it('online request fails (network error) → falls back to queue', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1));
    const { api } = pveApi({ onClear: () => new Error('network down') });
    const mgr = new SaveManager({ store, api });
    await mgr.recordClear('ch1_lv1', 1);
    expect(mgr.getPendingClears().map((p) => p.levelId)).toEqual(['ch1_lv1']);
  });

  it('upgrade: online → POST /pve/upgrade and adopt; offline → returns false, no endpoint called', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1));
    const cloud = makeNewSave('a', 2);
    cloud.pveUpgrades = { inf_hp: 1 };
    const { api, calls } = pveApi({ onUpgrade: () => cloud });
    const mgr = new SaveManager({ store, api });

    expect(await mgr.upgrade('inf_hp')).toBe(true);
    expect(calls.upgrades).toEqual(['inf_hp']);
    expect(mgr.get().pveUpgrades).toEqual({ inf_hp: 1 });

    const offline = pveApi({ hasToken: false });
    const mgr2 = new SaveManager({ store: new LocalSaveStore(new MemStorage()), api: offline.api });
    expect(await mgr2.upgrade('inf_hp')).toBe(false);
    expect(offline.calls.upgrades).toEqual([]);
  });

  it('upgrade fails (insufficient materials → ApiError) → false, local save unchanged', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1));
    const { api } = pveApi({ onUpgrade: () => new ApiError('INSUFFICIENT_FUNDS', 'no mats') });
    const mgr = new SaveManager({ store, api });
    expect(await mgr.upgrade('inf_hp')).toBe(false);
    expect(mgr.get().pveUpgrades).toEqual({});
  });

  it('flush queue after bootstrap/refresh: settle each entry in order, clear queue on success', async () => {
    const mem = new MemStorage();
    const store = new LocalSaveStore(mem);
    // Pre-populate two offline pending entries (simulating clears accumulated while offline)
    store.savePending([
      { levelId: 'ch1_lv1', stars: 2, ts: 1 },
      { levelId: 'ch1_lv1', stars: 3, ts: 2 },
    ]);
    store.saveLocal(makeNewSave('a', 1));
    const { api, calls } = pveApi({ onClear: () => makeNewSave('a', 2) });

    const mgr = new SaveManager({ store, api });
    expect(mgr.getPendingClears()).toHaveLength(2);
    await mgr.refresh(); // flushPending is called at the end of refresh

    expect(calls.clears).toEqual([
      { levelId: 'ch1_lv1', stars: 2 },
      { levelId: 'ch1_lv1', stars: 3 },
    ]);
    expect(mgr.getPendingClears()).toEqual([]);
    expect(store.loadPending()).toEqual([]); // also cleared on disk
  });

  it('flush: business error (ApiError) discards the entry without blocking the queue; network error retains it', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.savePending([
      { levelId: 'bad', stars: 1, ts: 1 },   // business error → discard
      { levelId: 'good', stars: 1, ts: 2 },  // network error → retain
    ]);
    store.saveLocal(makeNewSave('a', 1));
    const { api } = pveApi({
      onClear: (levelId) =>
        levelId === 'bad'
          ? new ApiError('BAD_REQUEST', 'level locked')
          : new Error('network'),
    });
    const mgr = new SaveManager({ store, api });
    await mgr.refresh();
    // bad is discarded; good is retained due to network failure
    expect(mgr.getPendingClears().map((p) => p.levelId)).toEqual(['good']);
  });

  it('online() reflects api/token state', () => {
    const store = new LocalSaveStore(new MemStorage());
    expect(new SaveManager({ store }).online()).toBe(false);
    expect(new SaveManager({ store, api: fakeApi(makeNewSave('a', 1), false) }).online()).toBe(false);
    expect(new SaveManager({ store, api: fakeApi(makeNewSave('a', 1), true) }).online()).toBe(true);
  });
});

// ── Stamina-at-entry (A4, 2026-07-06): deducted on spendStaminaForLevel, not on clear; local-first, works offline ──
describe('SaveManager.spendStaminaForLevel (A4)', () => {
  /** Records pveEnter calls and optionally pushes back an authoritative stamina snapshot / throws. */
  function staminaApi(opts: {
    hasToken?: boolean;
    onEnter?: (levelId: string) => { current: number; regenAt: number } | Error;
  }) {
    const calls: string[] = [];
    const api = {
      hasToken: () => opts.hasToken ?? true,
      getSave: async () => ({ save: makeNewSave('a', 1) }),
      pveEnter: async (levelId: string) => {
        calls.push(levelId);
        const r = opts.onEnter?.(levelId) ?? { current: 999, regenAt: 0 };
        if (r instanceof Error) throw r;
        return { stamina: r };
      },
    } as unknown as ApiClient;
    return { api, calls };
  }

  it('online success: local optimistic value then server value once the async call resolves', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1));
    let resolveEnter!: (v: { current: number; regenAt: number }) => void;
    const pending = new Promise<{ current: number; regenAt: number }>((res) => { resolveEnter = res; });
    const api = {
      hasToken: () => true,
      getSave: async () => ({ save: makeNewSave('a', 1) }),
      pveEnter: async () => ({ stamina: await pending }),
    } as unknown as ApiClient;
    const mgr = new SaveManager({ store, api });

    const ok = mgr.spendStaminaForLevel('ch1_lv1', 10);
    expect(ok).toBe(true);
    // Deducted locally right away, before the server round-trip resolves.
    expect(mgr.get().stamina?.current).toBe(110);

    resolveEnter({ current: 108, regenAt: 555 }); // server's own authoritative view (e.g. concurrent device also spent stamina)
    await Promise.resolve(); await Promise.resolve(); // let the .then() microtask run
    expect(mgr.get().stamina).toEqual({ current: 108, regenAt: 555 });
    expect(mgr.getPendingStaminaSpends()).toEqual([]); // resolved online, never queued
  });

  it('insufficient balance → false, nothing deducted', () => {
    const store = new LocalSaveStore(new MemStorage());
    const local = makeNewSave('a', 1);
    local.stamina = { current: 5, regenAt: 0 };
    store.saveLocal(local);
    const { api, calls } = staminaApi({});
    const mgr = new SaveManager({ store, api });

    expect(mgr.spendStaminaForLevel('ch1_lv1', 10)).toBe(false);
    expect(mgr.get().stamina?.current).toBe(5);
    expect(calls).toEqual([]); // never even attempts the server call
    expect(mgr.getPendingStaminaSpends()).toEqual([]);
  });

  it('offline: deducts the local mirror immediately (even with no network) and queues for later settlement', () => {
    const mem = new MemStorage();
    const store = new LocalSaveStore(mem);
    store.saveLocal(makeNewSave('a', 1));
    const { api, calls } = staminaApi({ hasToken: false });
    const mgr = new SaveManager({ store, api });

    expect(mgr.spendStaminaForLevel('ch1_lv1', 10)).toBe(true);
    expect(mgr.get().stamina?.current).toBe(110); // deducted locally despite being offline
    expect(calls).toEqual([]); // no request sent while offline
    expect(mgr.getPendingStaminaSpends().map((p) => p.levelId)).toEqual(['ch1_lv1']);
    // Persistence: a new instance restores both the deducted balance and the queue from storage.
    const mgr2 = new SaveManager({ store: new LocalSaveStore(mem), api });
    expect(mgr2.get().stamina?.current).toBe(110);
    expect(mgr2.getPendingStaminaSpends().map((p) => p.levelId)).toEqual(['ch1_lv1']);
  });

  it('online request fails (network error) → still deducted locally, falls back to queue', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1));
    const { api } = staminaApi({ onEnter: () => new Error('network down') });
    const mgr = new SaveManager({ store, api });

    expect(mgr.spendStaminaForLevel('ch1_lv1', 10)).toBe(true);
    expect(mgr.get().stamina?.current).toBe(110);
    await Promise.resolve(); await Promise.resolve(); // let the rejected promise's .catch() run
    expect(mgr.getPendingStaminaSpends().map((p) => p.levelId)).toEqual(['ch1_lv1']);
  });

  it('flush queue after bootstrap/refresh: settles each entry in order, adopts server stamina, clears queue', async () => {
    const mem = new MemStorage();
    const store = new LocalSaveStore(mem);
    const local = makeNewSave('a', 1);
    local.stamina = { current: 90, regenAt: 0 }; // simulates two offline spends already applied locally
    store.saveLocal(local);
    store.savePendingStamina([
      { levelId: 'ch1_lv1', cost: 10, ts: 1 },
      { levelId: 'ch1_lv2', cost: 10, ts: 2 },
    ]);
    const { api, calls } = staminaApi({ onEnter: () => ({ current: 80, regenAt: 999 }) });

    const mgr = new SaveManager({ store, api });
    expect(mgr.getPendingStaminaSpends()).toHaveLength(2);
    await mgr.refresh(); // flushPendingStamina runs at the end of refresh

    expect(calls).toEqual(['ch1_lv1', 'ch1_lv2']);
    expect(mgr.getPendingStaminaSpends()).toEqual([]);
    expect(store.loadPendingStamina()).toEqual([]); // also cleared on disk
    expect(mgr.get().stamina).toEqual({ current: 80, regenAt: 999 }); // last server response wins
  });

  it('flush: business error (ApiError) discards the entry without blocking the queue; network error retains it', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1));
    store.savePendingStamina([
      { levelId: 'bad', cost: 10, ts: 1 },   // business error → discard
      { levelId: 'good', cost: 10, ts: 2 },  // network error → retain
    ]);
    const { api } = staminaApi({
      onEnter: (levelId) =>
        levelId === 'bad'
          ? new ApiError('BAD_REQUEST', 'unknown level')
          : new Error('network'),
    });
    const mgr = new SaveManager({ store, api });
    await mgr.refresh();
    expect(mgr.getPendingStaminaSpends().map((p) => p.levelId)).toEqual(['good']);
  });

  it('regen catch-up: elapsed regen ticks since the last spend are applied even when a spend is blocked by insufficient balance', () => {
    const store = new LocalSaveStore(new MemStorage());
    const local = makeNewSave('a', 1);
    local.stamina = { current: 0, regenAt: Date.now() - 6 * 60 * 1000 }; // one regen tick (6 min) already elapsed
    store.saveLocal(local);
    const { api } = staminaApi({});
    const mgr = new SaveManager({ store, api });

    expect(mgr.spendStaminaForLevel('ch1_lv1', 10)).toBe(false); // a couple points regenerated, still far short of 10
    expect(mgr.get().stamina?.current).toBeGreaterThanOrEqual(1);
    expect(mgr.get().stamina?.current).toBeLessThan(10);
  });
});
