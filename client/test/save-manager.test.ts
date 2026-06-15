// SaveManager 单测。
//  · refresh()（S1-R）：ranked 局末服务器权威段（pvp）被改写后，客户端 pull + reconcile 即时刷新。
//  · PvE 服务器权威（PVE_INTEGRITY_PLAN §8）：progress/materials/pveUpgrades 取云端（不再并集/取较大）；
//    通关/升级走 /pve/* 端点；离线通关入队、上线 flush。
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
  it('拉取云端权威 pvp 覆盖本地（段位即时刷新）', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1)); // 本地仍是初始 unranked/1000
    const cloud = makeNewSave('a', 1);
    cloud.pvp = { elo: 1240, rank: 'gold', wins: 12, losses: 5, streak: 3 };

    const mgr = new SaveManager({ store, api: fakeApi(cloud) });
    expect(mgr.get().pvp.rank).toBe('unranked');

    const ok = await mgr.refresh();
    expect(ok).toBe(true);
    expect(mgr.get().pvp.rank).toBe('gold');
    expect(mgr.get().pvp.elo).toBe(1240);
    // 落本地，下次 loadLocal 也是新值
    expect(store.loadLocal().pvp.rank).toBe('gold');
  });

  it('progress/materials 以云端为准（§8 服务器权威，不再并集/取较大）', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const local = makeNewSave('a', 1);
    local.progress.cleared.push('ch1_lv1'); // 本地独有（未经服务器结算）
    local.materials = { scrap: 99 };
    store.saveLocal(local);

    const cloud = makeNewSave('a', 1);
    cloud.progress.cleared = ['ch1_lv2'];
    cloud.materials = { scrap: 3 };
    const mgr = new SaveManager({ store, api: fakeApi(cloud) });
    await mgr.refresh();
    // 云端权威完全覆盖：本地独有 ch1_lv1 / scrap:99 不保留
    expect(mgr.get().progress.cleared).toEqual(['ch1_lv2']);
    expect(mgr.get().materials).toEqual({ scrap: 3 });
  });

  it('equipped/flags 仍是客户端同步段（本地覆盖云端）', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const local = makeNewSave('a', 1);
    local.equipped = { skin: 'local_skin' };
    local.flags = { seen_intro: true };
    store.saveLocal(local);

    const cloud = makeNewSave('a', 1);
    cloud.equipped = { skin: 'cloud_skin' };
    const mgr = new SaveManager({ store, api: fakeApi(cloud) });
    await mgr.refresh();
    expect(mgr.get().equipped.skin).toBe('local_skin'); // 本地覆盖
    expect(mgr.get().flags.seen_intro).toBe(true);
  });

  it('未联通（无 token）→ no-op，返回 false', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const mgr = new SaveManager({ store, api: fakeApi(makeNewSave('a', 1), false) });
    expect(await mgr.refresh()).toBe(false);
  });

  it('无 api → false', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const mgr = new SaveManager({ store });
    expect(await mgr.refresh()).toBe(false);
  });

  it('refresh 回带 displayName → onProfile 回调（token 续登恢复展示名）', async () => {
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

describe('SaveManager.adoptSession (SA-3/SA-4 转正)', () => {
  it('登录后采纳 accountId + pull/reconcile：权威段（含 progress）取云端', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const local = makeNewSave('local-anon', 1); // 单机匿名档
    local.progress.cleared.push('ch1_lv1');
    store.saveLocal(local);

    const cloud = makeNewSave('real-123', 5); // 云端正式账号，已有权威段
    cloud.pvp = { elo: 1300, rank: 'gold', wins: 9, losses: 2, streak: 2 };
    cloud.wallet.coins = 500;
    cloud.progress.cleared = ['ch1_lv1', 'ch1_lv2'];

    const mgr = new SaveManager({ store, api: fakeApi(cloud) });
    const ok = await mgr.adoptSession('real-123');

    expect(ok).toBe(true);
    expect(mgr.get().accountId).toBe('real-123');
    expect(mgr.get().wallet.coins).toBe(500);
    expect(mgr.get().pvp.rank).toBe('gold');
    // progress 是服务器权威 → 取云端（本地未结算的进度不并入）
    expect(mgr.get().progress.cleared).toEqual(['ch1_lv1', 'ch1_lv2']);
  });

  it('无 token（pull 失败）→ 仍写下 accountId 但返回 false', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('local-anon', 1));
    const mgr = new SaveManager({ store, api: fakeApi(makeNewSave('x', 1), false) });
    expect(await mgr.adoptSession('real-123')).toBe(false);
    expect(mgr.get().accountId).toBe('real-123');
  });
});

// ── PvE 服务器权威：通关 / 升级 / 离线队列（§8）──────────────────────────
describe('SaveManager.recordClear / upgrade / pending (§8)', () => {
  /** 记录 pveClear/pveUpgrade 调用并按需回推权威 save。 */
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

  it('在线通关 → POST /pve/clear 并 adopt 回推（进度取服务器）', async () => {
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
    expect(mgr.getPendingClears()).toEqual([]); // 在线成功不入队
  });

  it('0 星不结算（未通关）', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const { api, calls } = pveApi({});
    const mgr = new SaveManager({ store, api });
    await mgr.recordClear('ch1_lv1', 0);
    expect(calls.clears).toEqual([]);
  });

  it('离线通关 → 入队待结算（不调端点、不改本地权威值），持久化本地', async () => {
    const mem = new MemStorage();
    const store = new LocalSaveStore(mem);
    store.saveLocal(makeNewSave('a', 1));
    const { api, calls } = pveApi({ hasToken: false });
    const mgr = new SaveManager({ store, api });

    await mgr.recordClear('ch1_lv1', 3);
    expect(calls.clears).toEqual([]); // 离线不发请求
    expect(mgr.getPendingClears().map((p) => p.levelId)).toEqual(['ch1_lv1']);
    expect(mgr.get().progress.cleared).toEqual([]); // 本地权威值未改
    // 持久化：新实例从存储恢复队列
    const mgr2 = new SaveManager({ store, api });
    expect(mgr2.getPendingClears().map((p) => p.levelId)).toEqual(['ch1_lv1']);
  });

  it('在线请求失败（网络）→ 入队兜底', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1));
    const { api } = pveApi({ onClear: () => new Error('network down') });
    const mgr = new SaveManager({ store, api });
    await mgr.recordClear('ch1_lv1', 1);
    expect(mgr.getPendingClears().map((p) => p.levelId)).toEqual(['ch1_lv1']);
  });

  it('upgrade：在线 → POST /pve/upgrade 并 adopt；离线 → false 不调端点', async () => {
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

  it('upgrade 失败（材料不足 → ApiError）→ false，不改本地', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.saveLocal(makeNewSave('a', 1));
    const { api } = pveApi({ onUpgrade: () => new ApiError('INSUFFICIENT_FUNDS', 'no mats') });
    const mgr = new SaveManager({ store, api });
    expect(await mgr.upgrade('inf_hp')).toBe(false);
    expect(mgr.get().pveUpgrades).toEqual({});
  });

  it('bootstrap/refresh 后 flush 队列：按序结算每条，成功后清队列', async () => {
    const mem = new MemStorage();
    const store = new LocalSaveStore(mem);
    // 预置两条离线待结算（模拟此前离线攒下的）
    store.savePending([
      { levelId: 'ch1_lv1', stars: 2, ts: 1 },
      { levelId: 'ch1_lv1', stars: 3, ts: 2 },
    ]);
    store.saveLocal(makeNewSave('a', 1));
    const { api, calls } = pveApi({ onClear: () => makeNewSave('a', 2) });

    const mgr = new SaveManager({ store, api });
    expect(mgr.getPendingClears()).toHaveLength(2);
    await mgr.refresh(); // refresh 末尾 flushPending

    expect(calls.clears).toEqual([
      { levelId: 'ch1_lv1', stars: 2 },
      { levelId: 'ch1_lv1', stars: 3 },
    ]);
    expect(mgr.getPendingClears()).toEqual([]);
    expect(store.loadPending()).toEqual([]); // 落盘也清空
  });

  it('flush 遇业务错误（ApiError）丢弃该条不卡队列；遇网络错误保留', async () => {
    const store = new LocalSaveStore(new MemStorage());
    store.savePending([
      { levelId: 'bad', stars: 1, ts: 1 },   // 业务错误 → 丢弃
      { levelId: 'good', stars: 1, ts: 2 },  // 网络错误 → 保留
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
    // bad 被丢弃，good 因网络失败保留
    expect(mgr.getPendingClears().map((p) => p.levelId)).toEqual(['good']);
  });

  it('online() 反映 api/token 状态', () => {
    const store = new LocalSaveStore(new MemStorage());
    expect(new SaveManager({ store }).online()).toBe(false);
    expect(new SaveManager({ store, api: fakeApi(makeNewSave('a', 1), false) }).online()).toBe(false);
    expect(new SaveManager({ store, api: fakeApi(makeNewSave('a', 1), true) }).online()).toBe(true);
  });
});
