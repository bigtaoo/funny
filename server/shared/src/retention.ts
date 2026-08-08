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

/**
 * "2026-W32"  ISO-8601 week key (Monday-start weeks; week 1 = the week containing the year's
 * first Thursday, standard ISO 8601 definition). First consumer: weekly active chest (§12.3,
 * "周活跃点 = 每日任务点 weekKey 累计") — no other system in the codebase used a week-scoped key
 * before this, only dayKey/monthKey (retention.ts, this file's original scope).
 */
export function makeWeekKey(tsMs: number): string {
  const d = new Date(tsMs);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Mon=1 .. Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // Thursday of this ISO week decides the ISO year
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(weekNo).padStart(2, '0')}`;
}

// ── Check-in calendar definition (ECONOMY_NUMBERS §12.1) ────────────────────────────────────

// 'coins' kept only for backward-compat parsing of old save snapshots — the *primary* slot kind
// still should almost never be coins (R1a: no new bulk coin faucet). 'material' delivers a fixed
// id+count from scrap/lead/binding (SaveData.materials keys). 'card'/'equipment' carry no fixed
// id: the actual item is drawn at claim time from the existing gacha catalogue (uniform pick
// within the category — see pickRandomCatalogItem in gachaCatalog.ts), so the table only marks
// the *slot*, not the prize. 'stamina' is no longer used by CHECKIN_REWARDS (2026-08-01, see R1b
// below) but stays a valid kind for old save snapshots that recorded it.
export type CheckinRewardKind = 'coins' | 'stamina' | 'material' | 'card' | 'equipment';

export interface CheckinReward {
  kind: CheckinRewardKind;
  count: number;
  /** Material id (scrap/lead/binding, SaveData.materials keys), only set when kind === 'material'. */
  id?: string;
  /**
   * Small coin top-up delivered alongside the primary reward, milestone slots only (2026-08-01,
   * R1b amendment — see RETENTION_DESIGN.md §2.1 changelog). Delivered the same way as `kind:
   * 'coins'` (commercial.grant), independent of the primary reward's delivery path.
   */
  bonusCoins?: number;
}

/**
 * 30-slot monthly calendar reward table (index 0 = slot 1). Regular days are materials only
 * (scrap/lead/binding drip, every day — no stamina: players claim on login the moment the red dot
 * appears, and stamina caps at 120 with 1pt/6min natural regen, so a flat stamina grant was
 * routinely wasted overflow, not a felt reward). Milestone days (7/14/21/30) keep their existing
 * "big" slot (material pack / card pack / mid-tier material pack / equipment finale) and *each*
 * additionally carries a small `bonusCoins` top-up (R1b, 2026-08-01): 30/40/50/80 = 200/month
 * total, a deliberate small amendment to R1 (see changelog) — negligible next to the existing
 * coin faucets (daily task 150/month, battlepass 960/month, victory coins up to 5,400/season).
 */
export const CHECKIN_REWARDS: CheckinReward[] = [
  { kind: 'material',  count: 3,   id: 'scrap' },    // 1
  { kind: 'material',  count: 3,   id: 'scrap' },    // 2
  { kind: 'material',  count: 2,   id: 'lead' },     // 3
  { kind: 'material',  count: 3,   id: 'scrap' },    // 4
  { kind: 'material',  count: 3,   id: 'scrap' },    // 5
  { kind: 'material',  count: 2,   id: 'lead' },     // 6
  { kind: 'material',  count: 5,   id: 'lead', bonusCoins: 30 },  // 7  ← milestone: material pack + coins
  { kind: 'material',  count: 3,   id: 'scrap' },    // 8
  { kind: 'material',  count: 3,   id: 'scrap' },    // 9
  { kind: 'material',  count: 2,   id: 'lead' },     // 10
  { kind: 'material',  count: 3,   id: 'scrap' },    // 11
  { kind: 'material',  count: 2,   id: 'lead' },     // 12
  { kind: 'material',  count: 3,   id: 'scrap' },    // 13
  { kind: 'card',      count: 1,   bonusCoins: 40 }, // 14 ← milestone: card pack (random draw) + coins
  { kind: 'material',  count: 3,   id: 'scrap' },    // 15
  { kind: 'material',  count: 3,   id: 'scrap' },    // 16
  { kind: 'material',  count: 2,   id: 'lead' },     // 17
  { kind: 'material',  count: 3,   id: 'scrap' },    // 18
  { kind: 'material',  count: 2,   id: 'lead' },     // 19
  { kind: 'material',  count: 3,   id: 'scrap' },    // 20
  { kind: 'material',  count: 5,   id: 'lead', bonusCoins: 50 },  // 21 ← milestone: mid-tier material pack + coins
  { kind: 'material',  count: 3,   id: 'scrap' },    // 22
  { kind: 'material',  count: 3,   id: 'scrap' },    // 23
  { kind: 'material',  count: 2,   id: 'lead' },     // 24
  { kind: 'material',  count: 3,   id: 'scrap' },    // 25
  { kind: 'material',  count: 1,   id: 'binding' },  // 26
  { kind: 'material',  count: 3,   id: 'scrap' },    // 27
  { kind: 'material',  count: 2,   id: 'lead' },     // 28
  { kind: 'material',  count: 3,   id: 'scrap' },    // 29
  { kind: 'equipment', count: 1,   bonusCoins: 80 }, // 30 ← milestone: month-end finale (random equipment draw) + coins
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

/** Full-point coin reward (daily cap: 5 coins × 30 = 150/month, §12.2 R1). */
export const DAILY_COINS_REWARD: number = 5;

// ── Weekly active chest (ECONOMY_NUMBERS §12.3, P1) ─────────────────────────────────────────
//
// Points accumulate from the same daily-task completions that feed DailyData.taskPoints (see
// accrueRetentionTask below) — a "周活跃点 = 每日任务点 weekKey 累计" tally, week-scoped instead
// of day-scoped and not reset by the daily coin claim. Three placeholder threshold tiers
// (30/60/100), each independently claimable once reached, all within the same ISO week.
//
// 2026-08-05 implementation notes (two deviations from the original design-doc wording):
//
// 1. Threshold values. The doc's placeholder thresholds were 30/60/100, inherited unchanged from
//    an earlier draft that assumed a richer weekly-point economy. Under the *actual* shipped daily
//    task economy (DAILY_TASKS: 3 tasks × 1 point, capped at DAILY_POINTS_THRESHOLD=3/day), a
//    7-day week accrues at most 21 points — 30 is unreachable, the feature would ship dead on
//    arrival. Rebased to 9/15/21 (3/5/7 days of a full task day within the week), keeping the
//    doc's "three escalating tiers, top tier ≈ a perfect week" intent but actually reachable.
//
// 2. Tier-3 reward kind. The doc's tier-3 example was "限定皮肤碎片 / 高价值材料" — a skin
//    *fragment* currency. No fragment/shard concept exists anywhere in the codebase (skins are
//    only ever granted whole, server/metaserver/src/skin.ts), and building one from scratch was
//    out of scope for this pass. Originally substituted a whole non-limited shop skin instead
//    (kind: 'skin', resolved via a shop-tier-only skin pool at claim time) — **superseded
//    2026-08-08** (user feedback: a shop skin felt like a weak flagship reward for a full-week
//    grind) with a random **legendary** (Anna-faction, "orange") card instead:
//    `pickRandomCatalogItem('card', rng, 'legendary')` narrows the same catalog pick checkin's
//    day-14 card milestone uses (which draws from *all* rarities) down to legendary only — a
//    materially better reward than checkin's, which fits the harder-to-reach full-week bar (21
//    points ≈ 7 perfect days) this tier gates on. Each tier is a single reward (not the doc's
//    tier2/tier3 "+ 材料" combo) to keep v1 simple; revisit both of these if real activity data
//    says the tiers feel off.

export type WeeklyChestRewardKind = 'material' | 'equipment' | 'card';

export interface WeeklyChestReward {
  kind: WeeklyChestRewardKind;
  count: number;
  /** Material id (scrap/lead/binding), only set when kind === 'material'. */
  id?: string;
}

export interface WeeklyChestTierDef {
  threshold: number;
  reward: WeeklyChestReward;
}

export const WEEKLY_CHEST_TIERS: WeeklyChestTierDef[] = [
  { threshold: 9,  reward: { kind: 'material',  count: 20, id: 'lead' } },     // 中级材料包（3 天满勤）
  { threshold: 15, reward: { kind: 'equipment', count: 1 } },                  // 低级装备，entry-tier equip_t1（5 天满勤）
  { threshold: 21, reward: { kind: 'card',      count: 1 } },                  // 随机传说卡（橙卡，Anna 阵营）→ 见上方实现说明（7 天满勤/满周）
];

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

export interface WeeklyData {
  weekKey: string;         // "2026-W32"
  points: number;          // accumulated weekly points (see accrueRetentionTask)
  claimedTiers: number[];  // WEEKLY_CHEST_TIERS thresholds claimed this ISO week
}

export interface RetentionSave {
  checkin?: CheckinData;
  daily?: DailyData;
  weekly?: WeeklyData;
}

// ── Lazy boundary reset (called on every server read/write) ────────────────────────────────────

/**
 * Compares monthKey/dayKey; if stale, zeroes out the corresponding block (lazy reset).
 * Pure function: returns a new value, or the original if nothing changed (avoids unnecessary DB writes).
 */
export function resetStaleRetention(retention: RetentionSave | undefined, tsMs: number): RetentionSave {
  const monthKey = makeMonthKey(tsMs);
  const dayKey = makeDayKey(tsMs);
  const weekKey = makeWeekKey(tsMs);
  const r: RetentionSave = retention ?? {};
  let changed = false;
  let checkin = r.checkin;
  let daily = r.daily;
  let weekly = r.weekly;
  if (checkin && checkin.monthKey !== monthKey) {
    checkin = undefined;
    changed = true;
  }
  if (daily && daily.dayKey !== dayKey) {
    daily = undefined;
    changed = true;
  }
  if (weekly && weekly.weekKey !== weekKey) {
    weekly = undefined;
    changed = true;
  }
  if (!changed) return r;
  const out: RetentionSave = {};
  if (checkin) out.checkin = checkin;
  if (daily) out.daily = daily;
  if (weekly) out.weekly = weekly;
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

/** Weekly points accrued so far this ISO week (0 if none recorded / stale). */
export function weeklyPoints(r: RetentionSave | undefined, tsMs: number): number {
  const weekKey = makeWeekKey(tsMs);
  if (!r?.weekly || r.weekly.weekKey !== weekKey) return 0;
  return r.weekly.points;
}

/** Chest tier thresholds reached this ISO week but not yet claimed (0-3 entries). */
export function weeklyClaimableTiers(r: RetentionSave | undefined, tsMs: number): number[] {
  const points = weeklyPoints(r, tsMs);
  const weekKey = makeWeekKey(tsMs);
  const claimed = r?.weekly?.weekKey === weekKey ? r.weekly.claimedTiers : [];
  return WEEKLY_CHEST_TIERS
    .filter((t) => points >= t.threshold && !claimed.includes(t.threshold))
    .map((t) => t.threshold);
}

/** Any retention reward claimable → show lobby red dot. */
export function hasRetentionClaimable(save: SaveData, tsMs: number): boolean {
  const r = save.retention;
  if (nextCheckinDay(r, tsMs) !== null) return true;
  if (dailyRewardClaimable(r, tsMs)) return true;
  if (weeklyClaimableTiers(r, tsMs).length > 0) return true;
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

  // Weekly active chest (§12.3): "周活跃点 = 每日任务点 weekKey 累计" — same task completion,
  // same idempotency guard above, just tallied into a week-scoped bucket instead of (in addition
  // to) the day-scoped one, uncapped by DAILY_POINTS_THRESHOLD (that cap only gates the *daily*
  // coin reward) and capped instead at the top chest tier so it can't run away past 100.
  const weekKey = makeWeekKey(tsMs);
  const prevWeekly: WeeklyData = r?.weekly?.weekKey === weekKey ? r.weekly : { weekKey, points: 0, claimedTiers: [] };
  const topTier = WEEKLY_CHEST_TIERS[WEEKLY_CHEST_TIERS.length - 1]?.threshold ?? Infinity;
  const weekly: WeeklyData = { ...prevWeekly, points: Math.min(topTier, prevWeekly.points + def.points) };

  return { ...(r ?? {}), daily: next, weekly };
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

export type WeeklyChestClaimError = 'NOT_REACHED' | 'ALREADY_CLAIMED' | 'BAD_REQUEST';

export interface WeeklyChestClaimOk {
  ok: true;
  threshold: number;
  reward: WeeklyChestReward;
  newWeekly: WeeklyData;
}

/**
 * Claims one weekly chest tier (mirrors claimBpReward's "array .includes() judges repeat" shape
 * — closer fit than claimCheckinDay's single-slot-per-day gate, since all three tiers can be
 * claimed independently within the same week once each is reached). Caller is responsible for
 * writing to DB and delivering `reward` (see liveops.ts claimWeeklyChest for the per-kind
 * delivery, mirroring claimCheckin's material/equipment/card branches).
 */
export function claimWeeklyTier(
  r: RetentionSave | undefined,
  threshold: number,
  tsMs: number,
): WeeklyChestClaimOk | { ok: false; error: WeeklyChestClaimError } {
  const tierDef = WEEKLY_CHEST_TIERS.find((t) => t.threshold === threshold);
  if (!tierDef) return { ok: false, error: 'BAD_REQUEST' };
  const weekKey = makeWeekKey(tsMs);
  const weekly: WeeklyData = r?.weekly?.weekKey === weekKey ? r.weekly : { weekKey, points: 0, claimedTiers: [] };
  if (weekly.points < threshold) return { ok: false, error: 'NOT_REACHED' };
  if (weekly.claimedTiers.includes(threshold)) return { ok: false, error: 'ALREADY_CLAIMED' };
  const newWeekly: WeeklyData = { ...weekly, claimedTiers: [...weekly.claimedTiers, threshold] };
  return { ok: true, threshold, reward: tierDef.reward, newWeekly };
}
