// 存档与契约类型。SaveData 是元系统单一权威根（META_DESIGN.md §3.1）。
// 与客户端 client/src/game/meta/SaveData.ts 镜像（S0-1）；本文件是服务端权威拷贝，
// 不依赖 client/src/game。openapi.yml 的 SaveData schema 与此同源。

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface LevelRecord {
  timeMs?: number;
  leaked?: number;
  [k: string]: unknown;
}

// ── 装备实例（EQUIPMENT_DESIGN §3.1）───────────────────────────────────────
// 目录（defId→槽位/稀有度/媒材/配方）在 equipment.ts；战斗数值在 @nw/engine。
import type { EquipRarity, EquipSlot } from './equipment';
import type { RankId } from './ladder';
import type { BattlePassData } from './battlepass';

/** 词条（主/副/特技统一形态）；id 指向词条池，value 为 roll 出的数值。 */
export interface Affix {
  id: string;
  value: number;
}

/** 装备实例（服务器权威；强化等级 / 词条 / 稀有度随件）。 */
export interface EquipmentInstance {
  id: string; // 实例 id（服务器生成）
  defId: string; // 装备定义 id（决定基础属性/槽位/媒材，见 equipment.ts）
  rarity: EquipRarity; // defId 的去规范化缓存，便于排序/查询
  level: number; // 强化等级 0..9
  affixes: Affix[]; // 词条（洗练可改）
  locked?: boolean; // 防误用为强化燃料
}

/** 单套 loadout 的槽位→实例 id 映射。 */
export type GearSlotMap = Partial<Record<EquipSlot, string /* instanceId */>>;

/** 穿戴：阶段一 global 全军共享；byUnit 预留按兵种（EQUIPMENT_DESIGN §3.1/§3.2）。 */
export interface GearLoadout {
  global?: GearSlotMap;
  byUnit?: Record<string /* unitType */, GearSlotMap>;
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
    // —— S11 赛季字段（SEASON_DESIGN §4）——
    /** pvp 数据所属赛季号；落后于时钟 current 即触发惰性迁移。 */
    seasonNo: number;
    /** 本赛季达到过的最高 ELO（每局结算时 max 追踪）。 */
    seasonPeakElo: number;
    /** 本赛季峰值段位（由 seasonPeakElo 推导；TITLE_DESIGN 赛季结算读此授称号）。 */
    seasonPeakRank: RankId;
    /** 历史首达过的段位 id（终身账本，首达金币幂等守卫，跨季不清）。 */
    reachedRanks: RankId[];
  };

  // —— 体力（A4）。服务器权威，实时扣；自然恢复 1 点/6 min，上限 120。缺省（老存档）视为满格。 ——
  // regenAt = 下一次回复 1 点的时间戳(ms)；已满时为 0（无需计时）。
  stamina?: { current: number; regenAt: number };

  // —— 称号（S10，TITLE_DESIGN §2）。服务器权威，PUT /save 不可写。缺省视为空集合，懒创建。 ——
  // 赛季结算 / 成就 claim / admin 授予写；equipped['title'] 是佩戴位（客户端同步段）。
  titles?: string[];

  // —— 战令（S11-C，SEASON_DESIGN §C）。服务器权威，PUT /save 不可写。缺省视为未参与，懒创建。 ——
  battlePass?: BattlePassData;

  // —— 成就系统（服务器权威，ACHIEVEMENT_DESIGN §3）。懒创建省存储；缺省视为全 0/空 ——
  // 计数只在 PvE/PvP 权威结算点写（A2）；PUT /save 白名单只收 equipped/flags，故这三段
  // 结构性丢弃（客户端塞了也不落库），无需额外守卫。
  stats?: Record<string, number>; // 终身累计统计（StatKey→值），单调递增
  achievements?: Record<string, { claimedTiers: number[] }>; // achId→已领阶号子集 ⊆ [1,2,3]
  antiCheat?: {
    // PvP 统计反作弊（§4.4），服务器权威，客户端只读甚至不下发
    statSuspicion: number; // 造假命中累计 → 决定抽查档位
    lastFlaggedTs?: number;
    // PvE 反作弊（S4-4）：录像复算不符计数；达阈值封号（pveBanned）。
    pveRejectCount?: number;
    pveBanned?: boolean;
  };

  // —— 客户端同步段（轻校验，§2）——
  progress: {
    cleared: string[];
    stars: Record<string, 1 | 2 | 3>;
    best: Record<string, LevelRecord>;
  };
  materials: Record<string, number>;
  /**
   * @deprecated S3-2 的 per-stat 材料升级（inf_hp/inf_dmg…）。S12 起单位养成改单一等级 + 集卡
   * 合成（见 unitLevels / cardInventory），引擎不再读此字段跑养成。保留供老存档兼容，S12 清理后退役。
   */
  pveUpgrades: Record<string, number>;
  // —— 单位养成（S12，ECONOMY_NUMBERS §4 / ADR-009）。服务器权威，PUT /save 不可写 ——
  /** 单位强度等级（unitId→1..9）= 各兵种最高拥有卡级，由 cardInventory 派生（deriveUnitLevels）。引擎读此跑蓝图。 */
  unitLevels: Record<string, number>;
  /** 单位卡库存：`${unitId}:${level}` → 张数。集卡合成（5→1）的原始来源。 */
  cardInventory: Record<string, number>;
  /** 皮肤穿戴（cosmetic，slot→skinId）。纯外观、无战力，故仍随 PUT /save 同步段上行。 */
  equipped: Record<string, string>;
  flags: Record<string, boolean>;

  // —— 装备系统（服务器权威，EQUIPMENT_DESIGN §3.1）。PUT /save 不可写，仅 /equipment/* 写 ——
  // 注：刻意不复用 cosmetic 的 `equipped`（其已承载皮肤选择），装备 loadout 独立放 `gear`。
  // 缺省（老存档）视为空——读取处一律 `?? {}` 兜底（无 migrate runner，惰性默认）。
  equipmentInv: Record<string, EquipmentInstance>; // instanceId → 实例
  gear: GearLoadout; // 穿戴 loadout
}

/**
 * PUT /save 仅接受的客户端同步段（SERVER_API.md §2.2）。
 * PVE_INTEGRITY_PLAN §8 起，progress/materials/pveUpgrades 升级为服务器权威
 * （只由 /pve/* + ranked 结算写），PUT /save 收窄为仅 equipped/flags。
 */
export type SyncPatch = Partial<Pick<SaveData, 'equipped' | 'flags'>>;

// v2（2026-06-21）：新增 equipmentInv + gear（装备系统 E0）。纯增字段、不动 equipped，
// 老存档惰性默认（读取处 `?? {}`），无破坏性迁移。
// v3（2026-06-21）：单位养成重做（S12）——新增 unitLevels + cardInventory；pveUpgrades 改 deprecated。
// 纯增字段，老存档惰性默认空（游戏未上线、无真实档，养成从 L1 重起，不做 pveUpgrades→unitLevels 换算）。
export const SAVE_VERSION = 3;

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
    pvp: {
      elo: 1000,
      rank: 'unranked',
      wins: 0,
      losses: 0,
      streak: 0,
      seasonNo: 1,
      seasonPeakElo: 1000,
      seasonPeakRank: 'bronze' as RankId,
      reachedRanks: [],
    },
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
