// 留存系统纯函数镜像（§4.1 客户端同算）。
// 与 server/shared/src/retention.ts 语义一致；不依赖 Node / DB。
import type { SaveData } from './SaveData';

export type DailyTaskId = 'pve.clear' | 'pvp.match' | 'ad.watch';
export type CheckinRewardKind = 'coins' | 'stamina';
export interface CheckinReward { kind: CheckinRewardKind; count: number }

// ── 时间 key（服务器 UTC，客户端只用于显示/对比，实际领取以服务器校验为准）────────────
export function makeDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}
export function makeMonthKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 7);
}

// ── 状态推导（同 server，无状态）──────────────────────────────────────────────────────

export function checkinClaimedCount(save: SaveData, tsMs: number): number {
  const monthKey = makeMonthKey(tsMs);
  const r = save.retention;
  if (!r?.checkin || r.checkin.monthKey !== monthKey) return 0;
  return r.checkin.claimedDays.length;
}

export function nextCheckinDay(save: SaveData, tsMs: number): number | null {
  const monthKey = makeMonthKey(tsMs);
  const dayKey = makeDayKey(tsMs);
  const todayNum = Number(dayKey.slice(8));
  const r = save.retention;
  const claimed = r?.checkin?.monthKey === monthKey ? r.checkin.claimedDays : [];
  const nextSlot = claimed.length + 1;
  if (nextSlot > 30) return null;
  if (claimed.length >= todayNum) return null;
  return nextSlot;
}

export function dailyTaskPoints(save: SaveData, tsMs: number): number {
  const dayKey = makeDayKey(tsMs);
  const r = save.retention;
  if (!r?.daily || r.daily.dayKey !== dayKey) return 0;
  return r.daily.taskPoints;
}

export function isDailyTaskDone(save: SaveData, taskId: DailyTaskId, tsMs: number): boolean {
  const dayKey = makeDayKey(tsMs);
  const r = save.retention;
  if (!r?.daily || r.daily.dayKey !== dayKey) return false;
  return (r.daily.completedTasks[taskId] ?? 0) > 0;
}

export function dailyRewardClaimable(save: SaveData, tsMs: number): boolean {
  const dayKey = makeDayKey(tsMs);
  const r = save.retention;
  if (!r?.daily || r.daily.dayKey !== dayKey) return false;
  return r.daily.taskPoints >= 3 && !r.daily.rewardClaimed;
}

/** 任一留存可领 → 大厅红点。 */
export function hasRetentionClaimable(save: SaveData, tsMs: number): boolean {
  if (nextCheckinDay(save, tsMs) !== null) return true;
  if (dailyRewardClaimable(save, tsMs)) return true;
  return false;
}
