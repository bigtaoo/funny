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

/** ISO-8601 week key ("2026-W32"), mirrors server/shared/src/retention.ts makeWeekKey exactly. */
export function makeWeekKey(tsMs: number): string {
  const d = new Date(tsMs);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(weekNo).padStart(2, '0')}`;
}

/** Weekly active chest tier thresholds (§12.3), mirrors server/shared/src/retention.ts WEEKLY_CHEST_TIERS thresholds. */
export const WEEKLY_CHEST_THRESHOLDS = [9, 15, 21] as const;

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

/** Weekly points accrued so far this ISO week (0 if none recorded / stale). */
export function weeklyPoints(save: SaveData, tsMs: number): number {
  const weekKey = makeWeekKey(tsMs);
  const r = save.retention;
  if (!r?.weekly || r.weekly.weekKey !== weekKey) return 0;
  return r.weekly.points;
}

/** Chest tier thresholds reached this ISO week but not yet claimed. */
export function weeklyClaimableTiers(save: SaveData, tsMs: number): number[] {
  const points = weeklyPoints(save, tsMs);
  const weekKey = makeWeekKey(tsMs);
  const r = save.retention;
  const claimed = r?.weekly?.weekKey === weekKey ? r.weekly.claimedTiers : [];
  return WEEKLY_CHEST_THRESHOLDS.filter((th) => points >= th && !claimed.includes(th));
}

/** Any retention reward claimable → lobby red dot. */
export function hasRetentionClaimable(save: SaveData, tsMs: number): boolean {
  if (nextCheckinDay(save, tsMs) !== null) return true;
  if (dailyRewardClaimable(save, tsMs)) return true;
  if (weeklyClaimableTiers(save, tsMs).length > 0) return true;
  return false;
}
