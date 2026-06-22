// SaveData —— 元系统单一权威根（META_DESIGN.md §3.1）。纯数据，无 PIXI / 无平台依赖。
// 本文件是客户端镜像；服务端权威拷贝在 server/shared/src/types.ts，openapi.yml 的 SaveData
// schema 与两者同源。改字段三处同步 + 加迁移（migrate.ts），否则废老存档。

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface LevelRecord {
  timeMs?: number;
  leaked?: number;
  [k: string]: unknown;
}

// ── 装备实例（EQUIPMENT_DESIGN §3.1）。客户端镜像，与 server/shared/src/types.ts 同源 ──
export type EquipSlot = 'weapon' | 'armor' | 'trinket';
export type EquipRarity = 'common' | 'fine' | 'rare' | 'epic';

/** 词条（主/副/特技统一形态）。 */
export interface Affix {
  id: string;
  value: number;
}

/** 装备实例（服务器权威，客户端只读）。 */
export interface EquipmentInstance {
  id: string;
  defId: string;
  rarity: EquipRarity;
  level: number; // 0..9
  affixes: Affix[];
  locked?: boolean;
}

export type GearSlotMap = Partial<Record<EquipSlot, string /* instanceId */>>;

/** 穿戴 loadout（global 全军 / byUnit 按兵种预留）。 */
export interface GearLoadout {
  global?: GearSlotMap;
  byUnit?: Record<string, GearSlotMap>;
}

export interface SaveData {
  version: number; // schema 版本，迁移用
  accountId: string; // 云存档身份（空串 = 尚未取得 / 纯本地）
  rev: number; // 单调递增修订号，乐观锁 / 冲突解决
  updatedAt: number; // 服务器时间戳（仅展示，客户端不可信）

  // —— 服务器权威段（客户端只读，§2）——
  // wallet/gacha 自 S5 起为 commercial 服务权威的只读镜像（meta 在经济操作回执后填，客户端不写）。
  wallet: { coins: number };
  inventory: {
    skins: string[];
    items: Record<string, number>;
  };
  gacha: { pity: Record<string, number> };
  // 已发货消费订单（commercial orderId）；服务器权威，客户端只读（S5-5）。
  deliveredOrders: string[];
  pvp: {
    elo: number;
    rank: string;
    wins: number;
    losses: number;
    streak: number;
    // —— S11 赛季字段（legacy 档可缺）——
    seasonNo?: number;
    seasonPeakElo?: number;
    seasonPeakRank?: string;
    reachedRanks?: string[];
  };
  // —— S11 战令（懒创建；本季首次打 ranked 或购买后出现）——
  battlePass?: {
    seasonNo: number;
    xp: number;
    level: number;
    hasPass: boolean;
    claimedFree: number[];
    claimedPaid: number[];
  };

  // —— 留存（B5，RETENTION_DESIGN）。服务器权威，PUT /save 不上行（客户端只读）。 ——
  retention?: {
    checkin?: { monthKey: string; claimedDays: number[] };
    daily?: { dayKey: string; completedTasks: Record<string, number>; taskPoints: number; rewardClaimed: boolean };
  };

  // —— 体力（A4，服务器权威，PUT /save 不上行）。每 6 min 恢复 1 点，上限 120。缺省视为满格。
  stamina?: { current: number; regenAt: number };

  // —— 称号（S10，TITLE_DESIGN §2）。服务器权威，PUT /save 不上行（客户端只读）。
  // 佩戴位在 equipped['title']（同步段，客户端可写），servers 据此广播对手称号。
  titles?: string[];

  // —— 客户端同步段（轻校验，§2）——
  progress: {
    cleared: string[];
    stars: Record<string, 1 | 2 | 3>;
    best: Record<string, LevelRecord>;
  };
  materials: Record<string, number>;
  /**
   * @deprecated S3-2 per-stat 材料升级。S12 起单位养成改单一等级 + 集卡合成（unitLevels/cardInventory），
   * 引擎不再读此跑养成。保留供老存档兼容，S12 清理后退役。
   */
  pveUpgrades: Record<string, number>;
  // —— 单位养成（S12，ECONOMY_NUMBERS §4）。服务器权威，客户端只读（不在 SyncPatch）——
  /** 单位强度等级 unitId→1..9，由 cardInventory 派生，引擎读此跑蓝图。 */
  unitLevels: Record<string, number>;
  /** 单位卡库存 `${unitId}:${level}`→张数，集卡合成（5→1）原始来源。 */
  cardInventory: Record<string, number>;
  /** 皮肤穿戴（cosmetic，slot→skinId）。纯外观，随同步段上行。 */
  equipped: Record<string, string>;
  flags: Record<string, boolean>;

  // —— 装备系统（服务器权威，客户端只读，EQUIPMENT_DESIGN §3.1）——
  // 独立于 cosmetic `equipped`（皮肤）；由 /equipment/* 服务器端点写，不进同步段。
  equipmentInv: Record<string, EquipmentInstance>;
  gear: GearLoadout;

  // —— 成就系统（服务器权威，ACHIEVEMENT_DESIGN §3）。懒创建：缺省视为全 0 / 空，
  //    legacy 档不迁移；客户端只读（PUT /save 不上行，A2）。antiCheat 不下发，故镜像不含。——
  stats?: Record<string, number>; // 终身累计统计（StatKey→值），单调递增
  achievements?: Record<string, { claimedTiers: number[] }>; // achId→已领阶号子集
}

/**
 * PUT /save 仅接受的客户端同步段（SERVER_API.md §2.2）。服务器权威段永不上行。
 * 与 server/shared/src/types.ts 的 SyncPatch 同构。
 * PVE_INTEGRITY_PLAN §8 起，progress/materials/pveUpgrades 升级为服务器权威
 * （只由 /pve/* + ranked 结算写），同步段收窄为仅 equipped/flags。
 */
export type SyncPatch = Partial<Pick<SaveData, 'equipped' | 'flags'>>;

/** 客户端同步段的字段名（push 抽取 / merge 用单一来源）。 */
export const SYNC_KEYS = ['equipped', 'flags'] as const;

// v2（2026-06-21）：新增 equipmentInv + gear（装备系统 E0）。migrate v1→v2 见 migrate.ts。
// v3（2026-06-21）：单位养成重做（S12）——新增 unitLevels + cardInventory，pveUpgrades 改 deprecated。
export const SAVE_VERSION = 3;

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
    deliveredOrders: [],
    pvp: { elo: 1000, rank: 'unranked', wins: 0, losses: 0, streak: 0 },
    progress: { cleared: [], stars: {}, best: {} },
    materials: {},
    pveUpgrades: {},
    unitLevels: {},
    cardInventory: {},
    equipped: {},
    flags: {},
    equipmentInv: {},
    gear: {},
  };
}

/** 抽出仅客户端同步段（equipped/flags），供 push 上行。 */
export function extractSyncPatch(save: SaveData): Required<SyncPatch> {
  return {
    equipped: save.equipped,
    flags: save.flags,
  };
}
