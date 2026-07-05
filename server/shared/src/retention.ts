// Single source of truth for retention system mechanics (RETENTION_DESIGN.md).
// Pure data + pure functions, no DB. Server-authoritative; client mirrors the same definitions to compute state (§4.1).
// Reward/threshold values: ECONOMY_NUMBERS §12 [DRAFT].

import type { SaveData } from './types';

// ── Time keys ─────────────────────────────────────────────────────────────────

/** "2026-06-22"  Server UTC day key (prevents cross-timezone farming, §3 R2). */
export function makeDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

/** "2026-06"  Month key (check-in calendar resets across months). */
export function makeMonthKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 7);
}

// ── Check-in calendar definition (ECONOMY_NUMBERS §12.1) ────────────────────────────────────

// 'coins' kept only for backward-compat parsing of old save snapshots — checkin itself should
// almost never grant coins (R1: not a new coin faucet). 'material' delivers a fixed id+count from
// scrap/lead/binding (SaveData.materials keys). 'card'/'equipment' carry no fixed id: the actual
// item is drawn at claim time from the existing gacha catalogue (uniform pick within the category
// — see pickRandomCatalogItem in gachaCatalog.ts), so the table only marks the *slot*, not the prize.
export type CheckinRewardKind = 'coins' | 'stamina' | 'material' | 'card' | 'equipment';

export interface CheckinReward {
  kind: CheckinRewardKind;
  count: number;
  /** Material id (scrap/lead/binding, SaveData.materials keys), only set when kind === 'material'. */
  id?: string;
}

/**
 * 30-slot monthly calendar reward table (index 0 = slot 1). Regular days alternate stamina with a
 * material drip (roughly 1 in 3); milestone days (7/14/21/30) are the "big" slots per
 * RETENTION_DESIGN §2.1: 7 = stamina pack, 14 = card pack (random draw), 21 = mid-tier material
 * pack, 30 = month-end finale (random equipment draw).
 */
export const CHECKIN_REWARDS: CheckinReward[] = [
  { kind: 'stamina',   count: 30 },                  // 1
  { kind: 'stamina',   count: 30 },                  // 2
  { kind: 'stamina',   count: 30 },                  // 3
  { kind: 'material',  count: 3,   id: 'scrap' },    // 4
  { kind: 'stamina',   count: 30 },                  // 5
  { kind: 'stamina',   count: 30 },                  // 6
  { kind: 'stamina',   count: 100 },                 // 7  ← milestone: stamina pack
  { kind: 'stamina',   count: 30 },                  // 8
  { kind: 'material',  count: 3,   id: 'scrap' },    // 9
  { kind: 'stamina',   count: 30 },                  // 10
  { kind: 'stamina',   count: 30 },                  // 11
  { kind: 'material',  count: 2,   id: 'lead' },     // 12
  { kind: 'stamina',   count: 30 },                  // 13
  { kind: 'card',      count: 1 },                   // 14 ← milestone: card pack (random draw)
  { kind: 'stamina',   count: 30 },                  // 15
  { kind: 'material',  count: 3,   id: 'scrap' },    // 16
  { kind: 'stamina',   count: 30 },                  // 17
  { kind: 'stamina',   count: 30 },                  // 18
  { kind: 'material',  count: 2,   id: 'lead' },     // 19
  { kind: 'stamina',   count: 30 },                  // 20
  { kind: 'material',  count: 5,   id: 'lead' },     // 21 ← milestone: mid-tier material pack
  { kind: 'stamina',   count: 30 },                  // 22
  { kind: 'material',  count: 3,   id: 'scrap' },    // 23
  { kind: 'stamina',   count: 30 },                  // 24
  { kind: 'stamina',   count: 30 },                  // 25
  { kind: 'material',  count: 1,   id: 'binding' },  // 26
  { kind: 'stamina',   count: 30 },                  // 27
  { kind: 'stamina',   count: 30 },                  // 28
  { kind: 'material',  count: 3,   id: 'scrap' },    // 29
  { kind: 'equipment', count: 1 },                   // 30 ← milestone: month-end finale (random equipment draw)
];

export const CHECKIN_TOTAL_DAYS = 30;
export const CHECKIN_MILESTONE_DAYS = [7, 14, 21, 30] as const;

// ── Daily task definitions (ECONOMY_NUMBERS §12.2) ────────────────────────────────────

export type DailyTaskId = 'pve.clear' | 'pvp.match' | 'gacha.draw';

export interface DailyTaskDef {
  id: DailyTaskId;
  points: number;
}

/** Current task pool (fixed 3 tasks, not randomly assigned in the early phase). */
export const DAILY_TASKS: DailyTaskDef[] = [
  { id: 'pve.clear',  points: 1 },  // clear any PvE level
  { id: 'pvp.match',  points: 1 },  // participate in any PvP match
  { id: 'gacha.draw', points: 1 },  // open one gacha pull
];

/** Daily full-point threshold (= all tasks completed). */
export const DAILY_POINTS_THRESHOLD: number = 3;

/** Full-point coin reward (daily cap: 2 coins × 30 ≈ 60/month, §12.2 R1). */
export const DAILY_COINS_REWARD: number = 2;

// ── Save data types (SaveData.retention sub-block) ──────────────────────────────────

export interface CheckinData {
  monthKey: string;       // "2026-06"
  claimedDays: number[];  // slots claimed this month (1-based), $addToSet idempotent
  lastClaimedDayKey?: string; // "2026-06-22", the calendar day of the most recent claim (gates one claim per real day)
}

export interface DailyData {
  dayKey: string;          // "2026-06-22"
  /** Completion state per task: taskId → points contributed (0 or taskDef.points, effectively boolean). */
  completedTasks: Partial<Record<DailyTaskId, number>>;
  taskPoints: number;      // accumulated task points for the day (= sum of completedTasks values)
  rewardClaimed: boolean;  // whether the daily full-point coin reward has been claimed
}

export interface RetentionSave {
  checkin?: CheckinData;
  daily?: DailyData;
}

// ── Lazy boundary reset (called on every server read/write) ────────────────────────────────────

/**
 * Compares monthKey/dayKey; if stale, zeroes out the corresponding block (lazy reset).
 * Pure function: returns a new value, or the original if nothing changed (avoids unnecessary DB writes).
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

// ── State derivation (§4.1, stateless, same computation on client and server) ──────────────────────────────

/** Total slots claimed this month. */
export function checkinClaimedCount(r: RetentionSave | undefined, tsMs: number): number {
  const monthKey = makeMonthKey(tsMs);
  if (!r?.checkin || r.checkin.monthKey !== monthKey) return 0;
  return r.checkin.claimedDays.length;
}

/** Next claimable slot number this month (1-based); null = already claimed today or month is full. */
export function nextCheckinDay(r: RetentionSave | undefined, tsMs: number): number | null {
  const monthKey = makeMonthKey(tsMs);
  const dayKey = makeDayKey(tsMs);
  const checkin = r?.checkin?.monthKey === monthKey ? r.checkin : undefined;
  const claimed = checkin?.claimedDays ?? [];
  const nextSlot = claimed.length + 1;
  if (nextSlot > CHECKIN_TOTAL_DAYS) return null;
  // Gated on the calendar day of the last claim (not on slot-vs-day-of-month), so a player who
  // is behind (e.g. slot 3 on the 20th) can't burn through slots 4..20 in one sitting — at most
  // one slot per real day, with no makeup requirement for previously missed days.
  if (checkin?.lastClaimedDayKey === dayKey) return null;
  return nextSlot;
}

/** Total task points for today. */
export function dailyTaskPoints(r: RetentionSave | undefined, tsMs: number): number {
  const dayKey = makeDayKey(tsMs);
  if (!r?.daily || r.daily.dayKey !== dayKey) return 0;
  return r.daily.taskPoints;
}

/** Whether a given task has already contributed points today. */
export function isDailyTaskDone(r: RetentionSave | undefined, taskId: DailyTaskId, tsMs: number): boolean {
  const dayKey = makeDayKey(tsMs);
  if (!r?.daily || r.daily.dayKey !== dayKey) return false;
  return (r.daily.completedTasks[taskId] ?? 0) > 0;
}

/** Whether the daily full-point reward is claimable (points have reached the threshold and not yet claimed). */
export function dailyRewardClaimable(r: RetentionSave | undefined, tsMs: number): boolean {
  const dayKey = makeDayKey(tsMs);
  if (!r?.daily || r.daily.dayKey !== dayKey) return false;
  return r.daily.taskPoints >= DAILY_POINTS_THRESHOLD && !r.daily.rewardClaimed;
}

/** Any retention reward claimable → show lobby red dot. */
export function hasRetentionClaimable(save: SaveData, tsMs: number): boolean {
  const r = save.retention;
  if (nextCheckinDay(r, tsMs) !== null) return true;
  if (dailyRewardClaimable(r, tsMs)) return true;
  return false;
}

// ── Server settlement point: accrue daily task points (§3.1) ─────────────────────────────────────

/**
 * Updates the daily task points after a server settlement event (idempotent: the same taskId can contribute at most once per day).
 * Pure function: returns the original value unchanged if nothing changes (avoids unnecessary DB writes).
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
  // Idempotent: skip if this task has already contributed
  if ((prev.completedTasks[taskId] ?? 0) > 0) return r;
  const completedTasks = { ...prev.completedTasks, [taskId]: def.points };
  const taskPoints = Math.min(DAILY_POINTS_THRESHOLD, prev.taskPoints + def.points);
  const next: DailyData = { ...prev, completedTasks, taskPoints };
  return { ...(r ?? {}), daily: next };
}

// ── Claim pure functions (§4.3, caller is responsible for DB writes) ────────────────────────────────────

export type CheckinClaimError = 'BAD_REQUEST' | 'ALREADY_CLAIMED_TODAY' | 'MONTH_FULL';

export interface CheckinClaimOk {
  ok: true;
  day: number;
  reward: CheckinReward;
  newCheckin: CheckinData;
}

/** Claims the next slot this month (idempotency check + returns new state). Caller is responsible for writing to DB. */
export function claimCheckinDay(
  r: RetentionSave | undefined,
  tsMs: number,
): CheckinClaimOk | { ok: false; error: CheckinClaimError } {
  const monthKey = makeMonthKey(tsMs);
  const dayKey = makeDayKey(tsMs);
  const prev: CheckinData = r?.checkin?.monthKey === monthKey
    ? r.checkin
    : { monthKey, claimedDays: [] };
  const nextSlot = prev.claimedDays.length + 1;
  if (nextSlot > CHECKIN_TOTAL_DAYS) return { ok: false, error: 'MONTH_FULL' };
  if (prev.lastClaimedDayKey === dayKey) return { ok: false, error: 'ALREADY_CLAIMED_TODAY' };
  const reward = CHECKIN_REWARDS[nextSlot - 1];
  if (!reward) return { ok: false, error: 'BAD_REQUEST' };
  const newCheckin: CheckinData = { monthKey, claimedDays: [...prev.claimedDays, nextSlot], lastClaimedDayKey: dayKey };
  return { ok: true, day: nextSlot, reward, newCheckin };
}

export type DailyClaimError = 'NOT_REACHED' | 'ALREADY_CLAIMED' | 'WRONG_DAY';

export interface DailyClaimOk {
  ok: true;
  coins: number;
}

/** Claims the daily full-point coin reward (idempotency check). Caller is responsible for writing to DB. */
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
