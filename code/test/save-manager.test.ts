// SaveManager.refresh() 单测（S1-R 收尾）：ranked 局末服务器权威段（pvp）被改写后，
// 客户端主动 pull + reconcile 即时刷新本地，无需等下次 bootstrap。
import { describe, it, expect } from 'vitest';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { makeNewSave, type SaveData } from '../src/game/meta';
import type { ApiClient } from '../src/net/ApiClient';
import type { IStorage } from '../src/platform/IPlatform';

class MemStorage implements IStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

function fakeApi(cloud: SaveData, hasToken = true): ApiClient {
  return {
    hasToken: () => hasToken,
    getSave: async () => cloud,
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

  it('客户端同步段（progress）不被 refresh 丢失（reconcile 取并集）', async () => {
    const store = new LocalSaveStore(new MemStorage());
    const local = makeNewSave('a', 1);
    local.progress.cleared.push('ch1_lv1');
    store.saveLocal(local);

    const cloud = makeNewSave('a', 1);
    cloud.pvp.elo = 1100;
    const mgr = new SaveManager({ store, api: fakeApi(cloud) });
    // 构造后内存里是 loadLocal 的本地档（含 ch1_lv1）
    await mgr.refresh();
    expect(mgr.get().progress.cleared).toContain('ch1_lv1');
    expect(mgr.get().pvp.elo).toBe(1100);
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
});
