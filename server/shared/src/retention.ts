// 留存系统机制单一来源（RETENTION_DESIGN.md）。
// 纯数据 + 纯函数，无 DB。服务端权威；客户端镜像同套定义算状态（§4.1）。
// 数值（奖励/阈值）: ECONOMY_NUMBERS §12 [DRAFT]。

import type { SaveData } from './types';

// ── 时间 key ─────────────────────────────────────────────────────────────────

/** "2026-06-22"  服务器 UTC 日键（防跨时区刷，§3 R2）。 */
export function makeDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

/** "2026-06"  月键（签到月历跨月重置）。 */
export function makeMonthKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 7);
}

// ── 签到月历定义（ECONOMY_NUMBERS §12.1）────────────────────────────────────

export type CheckinRewardKind = 'coins' | 'stamina';

export interface CheckinReward {
  kind: CheckinRewardKind;
  count: number;
}

/** 30 格月历奖励表（index 0 = 第 1 格，milestone 格标注）。 */
export const CHECKIN_REWARDS: CheckinReward[] = [
  { kind: 'stamina', count: 30 },   // 1
  { kind: 'stamina', count: 30 },   // 2
  { kind: 'stamina', count: 30 },   // 3
  { kind: 'stamina', count: 30 },   // 4
  { kind: 'stamina', count: 30 },   // 5
  { kind: 'stamina', count: 30 },   // 6
  { kind: 'coins',   count: 5  },   // 7  ← 里程碑：碎片包（用金币占位）
  { kind: 'stamina', count: 30 },   // 8
  { kind: 'stamina', count: 30 },   // 9
  { kind: 'stamina', count: 30 },   // 10
  { kind: 'stamina', count: 30 },   // 11
  { kind: 'stamina', count: 30 },   // 12
  { kind: 'stamina', count: 30 },   // 13
  { kind: 'coins',   count: 5  },   // 14 ← 里程碑：卡包
  { kind: 'stamina', count: 30 },   // 15
  { kind: 'stamina', count: 30 },   // 16
  { kind: 'stamina', count: 30 },   // 17
  { kind: 'stamina', count: 30 },   // 18
  { kind: 'stamina', count: 30 },   // 19
  { kind: 'stamina', count: 30 },   // 20
  { kind: 'coins',   count: 5  },   // 21 ← 里程碑：中级材料包
  { kind: 'stamina', count: 30 },   // 22
  { kind: 'stamina', count: 30 },   // 23
  { kind: 'stamina', count: 30 },   // 24
  { kind: 'stamina', count: 30 },   // 25
  { kind: 'stamina', count: 30 },   // 26
  { kind: 'stamina', count: 30 },   // 27
  { kind: 'stamina', count: 30 },   // 28
  { kind: 'stamina', count: 30 },   // 29
  { kind: 'coins',   count: 10 },   // 30 ← 月末压轴
];

export const CHECKIN_TOTAL_DAYS = 30;
export const CHECKIN_MILESTONE_DAYS = [7, 14, 21, 30] as const;

// ── 每日任务定义（ECONOMY_NUMBERS §12.2）────────────────────────────────────

export type DailyTaskId = 'pve.clear' | 'pvp.match' | 'gacha.draw';

export interface DailyTaskDef {
  id: DailyTaskId;
  points: number;
}

/** 当前任务池（固定 3 条，前期不随机派发）。 */
export const DAILY_TASKS: DailyTaskDef[] = [
  { id: 'pve.clear',  points: 1 },  // 通关任意 PvE 关卡
  { id: 'pvp.match',  points: 1 },  // 参与任意 PvP 对局
  { id: 'gacha.draw', points: 1 },  // 开一次盲盒
];

/** 当日满点阈值（= 完成所有任务）。 */
export const DAILY_POINTS_THRESHOLD: number = 3;

/** 满点金币奖励（日上限 2 coins × 30 ≈ 60/月，§12.2 R1）。 */
export const DAILY_COINS_REWARD: number = 2;

// ── 存档数据类型（SaveData.retention 子块）──────────────────────────────────

export interface CheckinData {
  monthKey: string;       // "2026-06"
  claimedDays: number[];  // 本月已领格号（1-based），$addToSet 幂等
}

export interface DailyData {
  dayKey: string;          // "2026-06-22"
  /** 各任务完成情况：taskId → 已贡献点数（0 或 taskDef.points，即布尔语义）。 */
  completedTasks: Partial<Record<DailyTaskId, number>>;
  taskPoints: number;      // 当日累计任务点（= sum of completedTasks values）
  rewardClaimed: boolean;  // 当日满点金币已领
}

export interface RetentionSave {
  checkin?: CheckinData;
  daily?: DailyData;
}

// ── 惰性边界重置（服务器每次读写时调用）────────────────────────────────────

/**
 * 比对 monthKey/dayKey，过期则归零对应块（懒重置）。
 * 纯函数：返回新值，若无变化返回原值（省写库）。
 */
export function resetStaleRetention(retention: RetentionSave | undefined, tsMs: number): RetentionSave {
  const monthKey = makeMonthKey(tsMs);
  const dayKey = makeDayKey(tsMs);
  const r: RetentionSave = retention ?? {};
  let changed = false;
  let checkin = r.checkin;
  let daily = r.daily;
  if (checkin && checkin.monthKey !== monthKey) {
    checkin = undefined;
    changed = true;
  }
  if (daily && daily.dayKey !== dayKey) {
    daily = undefined;
    changed = true;
  }
  if (!changed) return r;
  const out: RetentionSave = {};
  if (checkin) out.checkin = checkin;
  if (daily) out.daily = daily;
  return out;
}

// ── 状态推导（§4.1，无状态，客户端/服务器同算）──────────────────────────────

/** 当月已领格总数。 */
export function checkinClaimedCount(r: RetentionSave | undefined, tsMs: number): number {
  const monthKey = makeMonthKey(tsMs);
  if (!r?.checkin || r.checkin.monthKey !== monthKey) return 0;
  return r.checkin.claimedDays.length;
}

/** 当月下一可领格号（1-based）；null = 今日已领或月满。 */
export function nextCheckinDay(r: RetentionSave | undefined, tsMs: number): number | null {
  const monthKey = makeMonthKey(tsMs);
  const dayKey = makeDayKey(tsMs);
  const claimed = r?.checkin?.monthKey === monthKey ? r.checkin.claimedDays : [];
  const nextSlot = claimed.length + 1;
  if (nextSlot > CHECKIN_TOTAL_DAYS) return null;
  // 已经今日领过（最后一次领取时间 = 今天）
  const todayNum = Number(dayKey.slice(8)); // 1-31
  const lastClaimed = claimed.length > 0 ? Math.max(...claimed) : 0;
  // 简单判：今日日期是否已在已领集中（精确判「今天是否已领」需存 lastClaimedAt，先用 slot vs today 近似）
  // 采用 claimedDays 包含当日格的「下一格」逻辑：格号 = 已领数 + 1，按月历顺序严格推进。
  // 已领数 < 今天日期 → 还有可领格（不要求当天补领，温和档）。
  if (claimed.length >= todayNum) return null; // 今天的格已领（最多领到第 todayNum 格）
  return nextSlot;
}

/** 当日任务总点数。 */
export function dailyTaskPoints(r: RetentionSave | undefined, tsMs: number): number {
  const dayKey = makeDayKey(tsMs);
  if (!r?.daily || r.daily.dayKey !== dayKey) return 0;
  return r.daily.taskPoints;
}

/** 某任务今日是否已贡献过点数。 */
export function isDailyTaskDone(r: RetentionSave | undefined, taskId: DailyTaskId, tsMs: number): boolean {
  const dayKey = makeDayKey(tsMs);
  if (!r?.daily || r.daily.dayKey !== dayKey) return false;
  return (r.daily.completedTasks[taskId] ?? 0) > 0;
}

/** 当日满点奖励是否可领取（点数达阈值且未领）。 */
export function dailyRewardClaimable(r: RetentionSave | undefined, tsMs: number): boolean {
  const dayKey = makeDayKey(tsMs);
  if (!r?.daily || r.daily.dayKey !== dayKey) return false;
  return r.daily.taskPoints >= DAILY_POINTS_THRESHOLD && !r.daily.rewardClaimed;
}

/** 任一留存可领 → 大厅红点。 */
export function hasRetentionClaimable(save: SaveData, tsMs: number): boolean {
  const r = save.retention;
  if (nextCheckinDay(r, tsMs) !== null) return true;
  if (dailyRewardClaimable(r, tsMs)) return true;
  return false;
}

// ── 服务器结算点：累加每日任务点（§3.1）─────────────────────────────────────

/**
 * 某服务器结算事件发生后，更新对应每日任务点（幂等：同 taskId 今日最多贡献一次）。
 * 纯函数：不改变不返回原值（省写库）。
 */
export function accrueRetentionTask(
  r: RetentionSave | undefined,
  taskId: DailyTaskId,
  tsMs: number,
): RetentionSave | undefined {
  const dayKey = makeDayKey(tsMs);
  const def = DAILY_TASKS.find((t) => t.id === taskId);
  if (!def) return r;
  const prev: DailyData = r?.daily?.dayKey === dayKey
    ? r.daily
    : { dayKey, completedTasks: {}, taskPoints: 0, rewardClaimed: false };
  // 幂等：已贡献过该任务则跳过
  if ((prev.completedTasks[taskId] ?? 0) > 0) return r;
  const completedTasks = { ...prev.completedTasks, [taskId]: def.points };
  const taskPoints = Math.min(DAILY_POINTS_THRESHOLD, prev.taskPoints + def.points);
  const next: DailyData = { ...prev, completedTasks, taskPoints };
  return { ...(r ?? {}), daily: next };
}

// ── 领取纯函数（§4.3，服务器调用方落库）────────────────────────────────────

export type CheckinClaimError = 'BAD_REQUEST' | 'ALREADY_CLAIMED_TODAY' | 'MONTH_FULL';

export interface CheckinClaimOk {
  ok: true;
  day: number;
  reward: CheckinReward;
  newCheckin: CheckinData;
}

/** 领当月下一格（幂等校验 + 返回新状态）。调用方负责写库。 */
export function claimCheckinDay(
  r: RetentionSave | undefined,
  tsMs: number,
): CheckinClaimOk | { ok: false; error: CheckinClaimError } {
  const monthKey = makeMonthKey(tsMs);
  const dayKey = makeDayKey(tsMs);
  const todayNum = Number(dayKey.slice(8));
  const prev: CheckinData = r?.checkin?.monthKey === monthKey
    ? r.checkin
    : { monthKey, claimedDays: [] };
  const nextSlot = prev.claimedDays.length + 1;
  if (nextSlot > CHECKIN_TOTAL_DAYS) return { ok: false, error: 'MONTH_FULL' };
  if (prev.claimedDays.length >= todayNum) return { ok: false, error: 'ALREADY_CLAIMED_TODAY' };
  const reward = CHECKIN_REWARDS[nextSlot - 1];
  if (!reward) return { ok: false, error: 'BAD_REQUEST' };
  const newCheckin: CheckinData = { monthKey, claimedDays: [...prev.claimedDays, nextSlot] };
  return { ok: true, day: nextSlot, reward, newCheckin };
}

export type DailyClaimError = 'NOT_REACHED' | 'ALREADY_CLAIMED' | 'WRONG_DAY';

export interface DailyClaimOk {
  ok: true;
  coins: number;
}

/** 领当日满点金币（幂等校验）。调用方负责写库。 */
export function claimDailyReward(
  r: RetentionSave | undefined,
  tsMs: number,
): DailyClaimOk | { ok: false; error: DailyClaimError } {
  const dayKey = makeDayKey(tsMs);
  if (!r?.daily || r.daily.dayKey !== dayKey) return { ok: false, error: 'WRONG_DAY' };
  if (r.daily.taskPoints < DAILY_POINTS_THRESHOLD) return { ok: false, error: 'NOT_REACHED' };
  if (r.daily.rewardClaimed) return { ok: false, error: 'ALREADY_CLAIMED' };
  return { ok: true, coins: DAILY_COINS_REWARD };
}
