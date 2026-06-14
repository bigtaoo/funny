// 本地存档持久化（S0-3）。走 IPlatform.storage（key=nw_save_v1）。
// loadLocal 经 migrate 规整 + 兜底；saveLocal 序列化落盘。
//
// pull/push（云侧）不在本接口——它们依赖账号 + 网络，放 ApiClient + CloudSync（S0-5），
// SaveManager 组合两者。这样本地持久化零网络依赖，便于单测（喂内存 IStorage round-trip）。
//
// 旧 key 收编：历史上 nw_seen_intro 单独存。本模块在 loadLocal 时把它收编进 flags.seen_intro
// （保留旧 key 读兼容，不删旧 key）。nw_locale 是字符串、由 i18n 自管（flags 仅布尔），不收编。

import type { IStorage } from '../../platform/IPlatform';
import { migrate } from './migrate';
import { SAVE_STORAGE_KEY, type SaveData } from './SaveData';

/** 历史遗留 key —— 首次加载时收编进 SaveData.flags。 */
const LEGACY_SEEN_INTRO_KEY = 'nw_seen_intro';

export interface SaveStore {
  /** 读本地存档（含迁移 + 兜底 + 旧 key 收编）；从无则返回全新存档。 */
  loadLocal(): SaveData;
  /** 写本地存档。 */
  saveLocal(save: SaveData): void;
  /** 清空本地存档（调试 / 登出用）。 */
  clearLocal(): void;
}

export class LocalSaveStore implements SaveStore {
  constructor(private readonly storage: IStorage) {}

  loadLocal(): SaveData {
    let raw: unknown = null;
    const text = this.storage.getItem(SAVE_STORAGE_KEY);
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null; // 损坏存档 → 当作无，迁移为全新
      }
    }
    const save = migrate(raw);
    this.absorbLegacy(save);
    return save;
  }

  saveLocal(save: SaveData): void {
    this.storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(save));
  }

  clearLocal(): void {
    this.storage.removeItem(SAVE_STORAGE_KEY);
  }

  /** 把历史散 key 收编进 flags（仅当 flags 尚无该项时）。 */
  private absorbLegacy(save: SaveData): void {
    if (save.flags.seen_intro === undefined) {
      const legacy = this.storage.getItem(LEGACY_SEEN_INTRO_KEY);
      if (legacy) save.flags.seen_intro = true;
    }
  }
}
