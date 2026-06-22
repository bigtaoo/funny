// 战令（Battle Pass）系统（S11，SEASON_DESIGN.md §C）。纯数据 + 纯函数，无 DB / 无 PIXI。
// 奖励曲线数字初定；可调参见 ECONOMY_NUMBERS §13。

/** 战令最大等级（一个赛季内）。 */
export const BATTLEPASS_MAX_LEVEL = 30;

/** 买 Pass 费用（金币）。对标 ¥6 档（ECONOMY_BALANCE §2.2）。 */
export const BATTLEPASS_BUY_COST = 600;

/** ranked 局给予的赛季经验（胜利更多）。 */
export const BP_XP_PER_RANKED_WIN = 120;
export const BP_XP_PER_RANKED_LOSS = 40;

/** 单个等级所需累计经验（每级固定）。 */
export const BP_XP_PER_LEVEL = 600;

export type BpRewardKind = 'coins' | 'material' | 'skin';

export interface BpReward {
  kind: BpRewardKind;
  /** kind=coins → amount；kind=material/skin → id。 */
  id?: string;
  count: number;
}

export interface BpLevelDef {
  level: number; // 1..MAX_LEVEL
  /** 到达此等级所需的【累计经验】。 */
  xpRequired: number;
  free?: BpReward; // 免费轨奖励
  paid?: BpReward; // 付费轨奖励（需 hasPass）
}

/**
 * 战令等级定义表。免费轨每 5 级一枚小金币包；付费轨逐级有奖励，
 * 特殊档（10/20/30）发大额金币/材料。数值初定，待 ECONOMY_NUMBERS §13 校准。
 */
export const BATTLEPASS_DEFS: BpLevelDef[] = Array.from({ length: BATTLEPASS_MAX_LEVEL }, (_, i) => {
  const level = i + 1;
  const xpRequired = level * BP_XP_PER_LEVEL;

  let free: BpReward | undefined;
  let paid: BpReward | undefined;

  // 免费轨：每 5 级 50 金币
  if (level % 5 === 0) {
    free = { kind: 'coins', count: 50 };
  }
  // 特殊里程碑（免费轨额外发）
  if (level === 10) free = { kind: 'coins', count: 150 };
  if (level === 20) free = { kind: 'coins', count: 200 };
  if (level === 30) free = { kind: 'coins', count: 300 };

  // 付费轨：每级 20 金币 + 特殊里程碑
  paid = { kind: 'coins', count: 20 };
  if (level === 10) paid = { kind: 'coins', count: 200 };
  if (level === 20) paid = { kind: 'coins', count: 300 };
  if (level === 30) paid = { kind: 'coins', count: 500 };

  return { level, xpRequired, free, paid };
});

/** 给定累计经验，返回当前战令等级（1-based，最高 MAX_LEVEL）。 */
export function xpToLevel(xp: number): number {
  return Math.min(BATTLEPASS_MAX_LEVEL, Math.max(1, Math.floor(xp / BP_XP_PER_LEVEL) + 1));
}

/** 当前等级下达到下一级还需多少经验（展示用）。 */
export function xpToNextLevel(xp: number): number {
  if (xp >= BATTLEPASS_MAX_LEVEL * BP_XP_PER_LEVEL) return 0;
  const curLevel = xpToLevel(xp);
  return curLevel * BP_XP_PER_LEVEL - xp;
}

/** 战令数据块（SaveData.battlePass）。缺省视为「本季未参与」，懒创建。 */
export interface BattlePassData {
  seasonNo: number;     // 所属赛季，落后于时钟则跨季迁移重置
  xp: number;           // 本季累计赛季经验
  level: number;        // 由 xp 推导（缓存，方便展示）
  hasPass: boolean;     // 是否购买付费 Pass
  claimedFree: number[]; // 已领免费轨等级集合
  claimedPaid: number[]; // 已领付费轨等级集合（仅 hasPass 可领）
}

/** 新的/重置后的战令数据（跨季迁移后初始状态）。 */
export function makeFreshBattlePass(seasonNo: number): BattlePassData {
  return {
    seasonNo,
    xp: 0,
    level: 1,
    hasPass: false,
    claimedFree: [],
    claimedPaid: [],
  };
}

/** 战令领取错误码。 */
export type BpClaimError =
  | 'NOT_REACHED'     // 等级未解锁
  | 'ALREADY_CLAIMED' // 已领取
  | 'PASS_REQUIRED'   // 付费轨需 Pass
  | 'BAD_REQUEST';    // 参数非法

/**
 * 纯函数：校验并执行领取，返回 {新 battlePass, reward} 或错误码。
 * 不涉及 DB 操作，由 meta handler 包进乐观锁事务。
 */
export function claimBpReward(
  bp: BattlePassData,
  track: 'free' | 'paid',
  level: number,
): { ok: true; bp: BattlePassData; reward: BpReward } | { ok: false; error: BpClaimError } {
  if (level < 1 || level > BATTLEPASS_MAX_LEVEL) return { ok: false, error: 'BAD_REQUEST' };
  const def = BATTLEPASS_DEFS[level - 1];
  if (!def) return { ok: false, error: 'BAD_REQUEST' };
  if (level > bp.level) return { ok: false, error: 'NOT_REACHED' };
  if (track === 'free') {
    if (bp.claimedFree.includes(level)) return { ok: false, error: 'ALREADY_CLAIMED' };
    if (!def.free) return { ok: false, error: 'BAD_REQUEST' };
    return {
      ok: true,
      bp: { ...bp, claimedFree: [...bp.claimedFree, level] },
      reward: def.free,
    };
  } else {
    if (!bp.hasPass) return { ok: false, error: 'PASS_REQUIRED' };
    if (bp.claimedPaid.includes(level)) return { ok: false, error: 'ALREADY_CLAIMED' };
    if (!def.paid) return { ok: false, error: 'BAD_REQUEST' };
    return {
      ok: true,
      bp: { ...bp, claimedPaid: [...bp.claimedPaid, level] },
      reward: def.paid,
    };
  }
}

/**
 * 计算「战令跨季补发」：返回此玩家应补发的所有未领奖励列表（走邮件附件）。
 * 免费轨：所有已达等级的未领档位；付费轨：hasPass 时同上。
 */
export function pendingBpRewards(
  bp: BattlePassData,
): { track: 'free' | 'paid'; level: number; reward: BpReward }[] {
  const result: { track: 'free' | 'paid'; level: number; reward: BpReward }[] = [];
  const freeSet = new Set(bp.claimedFree);
  const paidSet = new Set(bp.claimedPaid);
  for (const def of BATTLEPASS_DEFS) {
    if (def.level > bp.level) break;
    if (def.free && !freeSet.has(def.level)) {
      result.push({ track: 'free', level: def.level, reward: def.free });
    }
    if (def.paid && bp.hasPass && !paidSet.has(def.level)) {
      result.push({ track: 'paid', level: def.level, reward: def.paid });
    }
  }
  return result;
}
