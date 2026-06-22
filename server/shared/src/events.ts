// 限时活动容器机制单一来源（B6，ADR-014）。
// 纯数据 + 纯函数，无 DB；服务端/客户端同用。

// ── 活动任务种类 ─────────────────────────────────────────────────────────────

/** 活动任务触发种类（对应服务端可钩挂的事件来源）。 */
export type EventTaskKind = 'pve.clear' | 'pvp.win' | 'ad.watch';

// ── 活动定义结构（存于 Mongo events 集合，admin 写入）──────────────────────

export interface EventTaskDef {
  /** 任务局部 id（活动内唯一，非全局 statKey）。 */
  taskId: string;
  /** 触发来源：与服务端钩点一一对应。 */
  kind: EventTaskKind;
  /** 完成所需触发次数。 */
  target: number;
  /** 完成后获得的活动积分。 */
  points: number;
}

export interface EventRewardDef {
  rewardId: string;
  /** 兑换所需积分。 */
  cost: number;
  /** 奖励种类（发奖走邮件附件 / commercial 金币）。 */
  kind: 'coins' | 'material' | 'skin';
  /** material/skin 的 id（coins 无需）。 */
  id?: string;
  /** 数量（coins 的面额 / 材料数量）。 */
  count?: number;
  /** 每账号最多领取次数；undefined = 不限。 */
  maxClaims?: number;
}

// ── 参与数据（存于 Mongo eventParticipants 集合，per-account per-event）──

export interface EventTaskProgress {
  taskId: string;
  /** 已触发次数（单调递增，不超过 target）。 */
  progress: number;
  /** 是否已获得本任务积分（幂等闸：满足 progress≥target 且未领过才 $inc points）。 */
  pointsGranted: boolean;
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 活动窗口是否有效（[windowStart, windowEnd) 区间）。 */
export function isEventActive(windowStart: number, windowEnd: number, now: number): boolean {
  return now >= windowStart && now < windowEnd;
}

/** 某任务在当前参与记录中的完成进度；缺省 = 0。 */
export function taskProgress(prog: EventTaskProgress[], taskId: string): number {
  return prog.find((p) => p.taskId === taskId)?.progress ?? 0;
}

/** 某奖励已领次数（参与记录 claimedRewards 是列表，重复领可多次）。 */
export function rewardClaimedCount(claimed: string[], rewardId: string): number {
  return claimed.filter((r) => r === rewardId).length;
}
