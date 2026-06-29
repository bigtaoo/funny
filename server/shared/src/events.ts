// Single source of truth for the time-limited event container mechanism (B6, ADR-014).
// Pure data + pure functions, no DB; shared between server and client.

// ── Event task kinds ─────────────────────────────────────────────────────────────

/** Event task trigger kinds (correspond to hookable event sources on the server). */
export type EventTaskKind = 'pve.clear' | 'pvp.win' | 'ad.watch';

// ── Event definition structure (stored in the Mongo events collection, written by admin) ──────────────────────

export interface EventTaskDef {
  /** Task-local id (unique within the event, not a global statKey). */
  taskId: string;
  /** Trigger source: maps one-to-one with server hook points. */
  kind: EventTaskKind;
  /** Number of triggers required to complete the task. */
  target: number;
  /** Event points awarded upon task completion. */
  points: number;
}

export interface EventRewardDef {
  rewardId: string;
  /** Points required to claim the reward. */
  cost: number;
  /** Reward kind (dispatched as mail attachment or commercial coin grant). */
  kind: 'coins' | 'material' | 'skin';
  /** Id for material/skin rewards (not needed for coins). */
  id?: string;
  /** Quantity (coin amount / material quantity). */
  count?: number;
  /** Maximum claims per account; undefined = unlimited. */
  maxClaims?: number;
}

// ── Participation data (stored in the Mongo eventParticipants collection, per-account per-event) ──

export interface EventTaskProgress {
  taskId: string;
  /** Number of triggers so far (monotonically increasing, never exceeds target). */
  progress: number;
  /** Whether points for this task have already been granted (idempotency gate: only $inc points when progress≥target and not yet granted). */
  pointsGranted: boolean;
}

// ── Admin write input + validation (used by the ops admin console to create/edit events) ──────────────────────────

/** Valid task kinds (same source as EventTaskKind, for admin validation / frontend dropdowns). */
export const EVENT_TASK_KINDS: readonly EventTaskKind[] = ['pve.clear', 'pvp.win', 'ad.watch'];
/** Valid reward kinds. */
export const EVENT_REWARD_KINDS: readonly EventRewardDef['kind'][] = ['coins', 'material', 'skin'];

/** Input for creating/editing an event (_id/createdAt are filled in by the server; id optionally specifies _id). */
export interface EventInput {
  /** Specify eventId (ops-defined custom value; server generates a UUID if omitted). */
  id?: string;
  title: string;
  description?: string;
  windowStart: number;
  windowEnd: number;
  tasks: EventTaskDef[];
  rewards: EventRewardDef[];
}

/**
 * Validate event input; returns null if valid, or an error description string if not
 * (dirty data in the database will cause settlement/claim to throw).
 * Must be called on the server before writing to DB; the client can call the same function for instant feedback.
 */
export function validateEventInput(input: EventInput): string | null {
  if (typeof input.title !== 'string' || input.title.trim() === '' || input.title.length > 80) {
    return '活动名称必填且 ≤80 字';
  }
  if (!Number.isFinite(input.windowStart) || !Number.isFinite(input.windowEnd)) {
    return 'windowStart / windowEnd 必须是时间戳（ms）';
  }
  if (input.windowEnd <= input.windowStart) {
    return '结束时间必须晚于开始时间';
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) return '至少需要 1 个任务';
  if (!Array.isArray(input.rewards) || input.rewards.length === 0) return '至少需要 1 个奖励';

  const taskIds = new Set<string>();
  for (const t of input.tasks) {
    if (!t.taskId || typeof t.taskId !== 'string') return '任务 taskId 必填';
    if (taskIds.has(t.taskId)) return `任务 taskId 重复：${t.taskId}`;
    taskIds.add(t.taskId);
    if (!EVENT_TASK_KINDS.includes(t.kind)) return `任务 ${t.taskId} 的 kind 非法：${t.kind}`;
    if (!Number.isInteger(t.target) || t.target <= 0) return `任务 ${t.taskId} 的 target 必须为正整数`;
    if (!Number.isInteger(t.points) || t.points <= 0) return `任务 ${t.taskId} 的 points 必须为正整数`;
  }

  const rewardIds = new Set<string>();
  for (const r of input.rewards) {
    if (!r.rewardId || typeof r.rewardId !== 'string') return '奖励 rewardId 必填';
    if (rewardIds.has(r.rewardId)) return `奖励 rewardId 重复：${r.rewardId}`;
    rewardIds.add(r.rewardId);
    if (!EVENT_REWARD_KINDS.includes(r.kind)) return `奖励 ${r.rewardId} 的 kind 非法：${r.kind}`;
    if (!Number.isInteger(r.cost) || r.cost < 0) return `奖励 ${r.rewardId} 的 cost 必须为非负整数`;
    if (r.kind === 'coins') {
      if (!Number.isInteger(r.count) || (r.count ?? 0) <= 0) return `奖励 ${r.rewardId}（金币）需正整数 count`;
    } else if (!r.id) {
      return `奖励 ${r.rewardId}（${r.kind}）需指定 id`;
    }
    if (r.maxClaims !== undefined && (!Number.isInteger(r.maxClaims) || r.maxClaims <= 0)) {
      return `奖励 ${r.rewardId} 的 maxClaims 必须为正整数`;
    }
  }
  return null;
}

// ── Utility functions ────────────────────────────────────────────────────────────────

/** Whether the event window is active ([windowStart, windowEnd) interval). */
export function isEventActive(windowStart: number, windowEnd: number, now: number): boolean {
  return now >= windowStart && now < windowEnd;
}

/** Completion progress of a task in the current participation record; defaults to 0. */
export function taskProgress(prog: EventTaskProgress[], taskId: string): number {
  return prog.find((p) => p.taskId === taskId)?.progress ?? 0;
}

/** Number of times a reward has been claimed (claimedRewards in the participation record is a list; the same reward can appear multiple times). */
export function rewardClaimedCount(claimed: string[], rewardId: string): number {
  return claimed.filter((r) => r === rewardId).length;
}
