// Retention system pure-function mirror (§4.1 client-side co-computation).
// Semantically consistent with server/shared/src/retention.ts; no Node / DB dependencies.
import type { SaveData } from './SaveData';

export type DailyTaskId = 'pve.clear' | 'pvp.match' | 'gacha.draw';
export type CheckinRewardKind = 'coins' | 'stamina';
export interface CheckinReward { kind: CheckinRewardKind; count: number }

// ── Time keys (server UTC; client uses these for display/comparison only; actual claims are server-validated) ─────
export function makeDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}
export function makeMonthKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 7);
}

// ── State derivation (same as server, stateless) ─────────────────────────────────────

export function checkinClaimedCount(save: SaveData, tsMs: number): number {
  const monthKey = makeMonthKey(tsMs);
  const r = save.retention;
  if (!r?.checkin || r.checkin.monthKey !== monthKey) return 0;
  return r.checkin.claimedDays.length;
}

export function nextCheckinDay(save: SaveData, tsMs: number): number | null {
  const monthKey = makeMonthKey(tsMs);
  const dayKey = makeDayKey(tsMs);
  const r = save.retention;
  const checkin = r?.checkin?.monthKey === monthKey ? r.checkin : undefined;
  const claimed = checkin?.claimedDays ?? [];
  const nextSlot = claimed.length + 1;
  if (nextSlot > 30) return null;
  // Gated on the calendar day of the last claim, not slot-vs-day-of-month — at most one slot
  // claimable per real day, matching server/shared/src/retention.ts.
  if (checkin?.lastClaimedDayKey === dayKey) return null;
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

/** Any retention reward claimable → lobby red dot. */
export function hasRetentionClaimable(save: SaveData, tsMs: number): boolean {
  if (nextCheckinDay(save, tsMs) !== null) return true;
  if (dailyRewardClaimable(save, tsMs)) return true;
  return false;
}
