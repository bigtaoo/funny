// SaveData —— 元系统单一权威根（META_DESIGN.md §3.1）。纯数据，无 PIXI / 无平台依赖。
// 本文件是客户端镜像；服务端权威拷贝在 server/shared/src/types.ts，openapi.yml 的 SaveData
// schema 与两者同源。改字段三处同步 + 加迁移（migrate.ts），否则废老存档。

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface LevelRecord {
  timeMs?: number;
  leaked?: number;
  [k: string]: unknown;
}

export interface SaveData {
  version: number; // schema 版本，迁移用
  accountId: string; // 云存档身份（空串 = 尚未取得 / 纯本地）
  rev: number; // 单调递增修订号，乐观锁 / 冲突解决
  updatedAt: number; // 服务器时间戳（仅展示，客户端不可信）

  // —— 服务器权威段（客户端只读，§2）——
  wallet: { coins: number };
  inventory: {
    skins: string[];
    items: Record<string, number>;
  };
  gacha: { pity: Record<string, number> };
  pvp: {
    elo: number;
    rank: string;
    wins: number;
    losses: number;
    streak: number;
  };

  // —— 客户端同步段（轻校验，§2）——
  progress: {
    cleared: string[];
    stars: Record<string, 1 | 2 | 3>;
    best: Record<string, LevelRecord>;
  };
  materials: Record<string, number>;
  pveUpgrades: Record<string, number>;
  equipped: Record<string, string>;
  flags: Record<string, boolean>;
}

/**
 * PUT /save 仅接受的客户端同步段（SERVER_API.md §2.2）。服务器权威段永不上行。
 * 与 server/shared/src/types.ts 的 SyncPatch 同构。
 */
export type SyncPatch = Partial<
  Pick<SaveData, 'progress' | 'materials' | 'pveUpgrades' | 'equipped' | 'flags'>
>;

/** 客户端同步段的字段名（push 抽取 / merge 用单一来源）。 */
export const SYNC_KEYS = [
  'progress',
  'materials',
  'pveUpgrades',
  'equipped',
  'flags',
] as const;

export const SAVE_VERSION = 1;

/** 本地存档主 key（IPlatform.storage）。 */
export const SAVE_STORAGE_KEY = 'nw_save_v1';

/** 新账号的默认存档。所有权威段从零起步（与服务端 makeNewSave 一致）。 */
export function makeNewSave(accountId = '', now = 0): SaveData {
  return {
    version: SAVE_VERSION,
    accountId,
    rev: 0,
    updatedAt: now,
    wallet: { coins: 0 },
    inventory: { skins: [], items: {} },
    gacha: { pity: {} },
    pvp: { elo: 1000, rank: 'unranked', wins: 0, losses: 0, streak: 0 },
    progress: { cleared: [], stars: {}, best: {} },
    materials: {},
    pveUpgrades: {},
    equipped: {},
    flags: {},
  };
}

/** 抽出仅客户端同步段，供 push 上行。 */
export function extractSyncPatch(save: SaveData): Required<SyncPatch> {
  return {
    progress: save.progress,
    materials: save.materials,
    pveUpgrades: save.pveUpgrades,
    equipped: save.equipped,
    flags: save.flags,
  };
}
