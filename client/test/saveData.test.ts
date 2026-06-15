import { describe, it, expect } from 'vitest';
import {
  makeNewSave,
  migrate,
  SAVE_VERSION,
  SAVE_STORAGE_KEY,
  extractSyncPatch,
  type SaveData,
} from '../src/game/meta';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import type { IStorage } from '../src/platform/IPlatform';

/** 内存 IStorage（测试替身）。 */
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
  it('null / 非对象 → 全新存档', () => {
    expect(migrate(null)).toEqual(makeNewSave());
    expect(migrate(undefined)).toEqual(makeNewSave());
    expect(migrate(42)).toEqual(makeNewSave());
  });

  it('残缺对象补全到当前 version，保留已有字段', () => {
    const raw = { progress: { cleared: ['ch1_lv1'] } };
    const s = migrate(raw);
    expect(s.version).toBe(SAVE_VERSION);
    expect(s.progress.cleared).toEqual(['ch1_lv1']);
    // 缺的子字段被补齐
    expect(s.progress.stars).toEqual({});
    expect(s.wallet).toEqual({ coins: 0 });
    expect(s.pvp.elo).toBe(1000);
  });

  it('v0（无 version）升级到 v1', () => {
    const raw = { wallet: { coins: 7 }, materials: { wood: 3 } };
    const s = migrate(raw);
    expect(s.version).toBe(SAVE_VERSION);
    expect(s.wallet.coins).toBe(7);
    expect(s.materials.wood).toBe(3);
  });

  it('动态键（best / flags 自定义项）被保留', () => {
    const raw: Partial<SaveData> = {
      version: 1,
      progress: { cleared: [], stars: {}, best: { ch1_lv2: { timeMs: 1234 } } },
      flags: { custom_flag: true },
    } as SaveData;
    const s = migrate(raw);
    expect(s.progress.best.ch1_lv2).toEqual({ timeMs: 1234 });
    expect(s.flags.custom_flag).toBe(true);
  });

  it('迁移幂等：migrate(migrate(x)) === migrate(x)', () => {
    const once = migrate({ progress: { cleared: ['a'] } });
    expect(migrate(once)).toEqual(once);
  });
});

describe('LocalSaveStore round-trip (S0-3)', () => {
  it('saveLocal → loadLocal 一致', () => {
    const store = new LocalSaveStore(new MemStorage());
    const s = makeNewSave('acc-1', 100);
    s.materials.iron = 5;
    s.progress.cleared.push('ch1_lv1');
    store.saveLocal(s);
    expect(store.loadLocal()).toEqual(s);
  });

  it('空存储 → 全新存档', () => {
    const store = new LocalSaveStore(new MemStorage());
    expect(store.loadLocal()).toEqual(makeNewSave());
  });

  it('损坏 JSON → 退化为全新存档（不抛）', () => {
    const mem = new MemStorage();
    mem.setItem(SAVE_STORAGE_KEY, '{not valid json');
    const store = new LocalSaveStore(mem);
    expect(store.loadLocal()).toEqual(makeNewSave());
  });

  it('收编遗留 nw_seen_intro → flags.seen_intro', () => {
    const mem = new MemStorage();
    mem.setItem('nw_seen_intro', '1');
    const store = new LocalSaveStore(mem);
    expect(store.loadLocal().flags.seen_intro).toBe(true);
  });

  it('已有 flags.seen_intro 时不被遗留 key 覆盖', () => {
    const mem = new MemStorage();
    mem.setItem('nw_seen_intro', '1');
    const store = new LocalSaveStore(mem);
    const s = makeNewSave();
    s.flags.seen_intro = false;
    store.saveLocal(s);
    expect(store.loadLocal().flags.seen_intro).toBe(false);
  });
});

describe('extractSyncPatch (S0-1 / PvE 服务器权威 §8)', () => {
  it('收窄为仅 equipped/flags（progress/materials/pveUpgrades 升级为服务器权威，不再上行）', () => {
    const patch = extractSyncPatch(makeNewSave());
    expect(Object.keys(patch).sort()).toEqual(['equipped', 'flags'].sort());
    // 权威段永不上行
    expect('wallet' in patch).toBe(false);
    expect('pvp' in patch).toBe(false);
    // §8 起这三段也是服务器权威（只由 /pve/* 写），PUT /save 不接受
    expect('progress' in patch).toBe(false);
    expect('materials' in patch).toBe(false);
    expect('pveUpgrades' in patch).toBe(false);
  });
});
