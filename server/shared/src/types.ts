// 存档与契约类型。SaveData 是元系统单一权威根（META_DESIGN.md §3.1）。
// 与客户端 code/src/game/meta/SaveData.ts 镜像（S0-1）；本文件是服务端权威拷贝，
// 不依赖 code/src/game。openapi.yml 的 SaveData schema 与此同源。

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface LevelRecord {
  timeMs?: number;
  leaked?: number;
  [k: string]: unknown;
}

export interface SaveData {
  version: number;
  accountId: string;
  rev: number;
  updatedAt: number;

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

/** PUT /save 仅接受的客户端同步段（SERVER_API.md §2.2）。 */
export type SyncPatch = Partial<
  Pick<SaveData, 'progress' | 'materials' | 'pveUpgrades' | 'equipped' | 'flags'>
>;

export const SAVE_VERSION = 1;

/** 新账号的默认存档。所有权威段从零起步。 */
export function makeNewSave(accountId: string, now: number): SaveData {
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
