// 存档与契约类型。SaveData 是元系统单一权威根（META_DESIGN.md §3.1）。
// 与客户端 client/src/game/meta/SaveData.ts 镜像（S0-1）；本文件是服务端权威拷贝，
// 不依赖 client/src/game。openapi.yml 的 SaveData schema 与此同源。

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
  // wallet/gacha 自 S5 起为 commercial 服务权威的只读镜像（meta 在经济操作回执后填）。
  wallet: { coins: number };
  inventory: {
    skins: string[];
    items: Record<string, number>;
  };
  gacha: { pity: Record<string, number> };
  // 已发货消费订单（commercial orderId）。发货幂等账本：补发用 $addToSet + $ne 守卫去重（S5-5）。
  deliveredOrders: string[];
  pvp: {
    elo: number;
    rank: string;
    wins: number;
    losses: number;
    streak: number;
  };

  // —— 成就系统（服务器权威，ACHIEVEMENT_DESIGN §3）。懒创建省存储；缺省视为全 0/空 ——
  // 计数只在 PvE/PvP 权威结算点写（A2）；PUT /save 白名单只收 equipped/flags，故这三段
  // 结构性丢弃（客户端塞了也不落库），无需额外守卫。
  stats?: Record<string, number>; // 终身累计统计（StatKey→值），单调递增
  achievements?: Record<string, { claimedTiers: number[] }>; // achId→已领阶号子集 ⊆ [1,2,3]
  antiCheat?: {
    // PvP 统计反作弊（§4.4），服务器权威，客户端只读甚至不下发
    statSuspicion: number; // 造假命中累计 → 决定抽查档位
    lastFlaggedTs?: number;
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
 * PUT /save 仅接受的客户端同步段（SERVER_API.md §2.2）。
 * PVE_INTEGRITY_PLAN §8 起，progress/materials/pveUpgrades 升级为服务器权威
 * （只由 /pve/* + ranked 结算写），PUT /save 收窄为仅 equipped/flags。
 */
export type SyncPatch = Partial<Pick<SaveData, 'equipped' | 'flags'>>;

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
    deliveredOrders: [],
    pvp: { elo: 1000, rank: 'unranked', wins: 0, losses: 0, streak: 0 },
    progress: { cleared: [], stars: {}, best: {} },
    materials: {},
    pveUpgrades: {},
    equipped: {},
    flags: {},
  };
}
