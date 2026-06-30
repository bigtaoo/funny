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
    return 'Event title is required and must be ≤80 characters';
  }
  if (!Number.isFinite(input.windowStart) || !Number.isFinite(input.windowEnd)) {
    return 'windowStart / windowEnd must be timestamps (ms)';
  }
  if (input.windowEnd <= input.windowStart) {
    return 'End time must be after start time';
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) return 'At least 1 task is required';
  if (!Array.isArray(input.rewards) || input.rewards.length === 0) return 'At least 1 reward is required';

  const taskIds = new Set<string>();
  for (const t of input.tasks) {
    if (!t.taskId || typeof t.taskId !== 'string') return 'Task taskId is required';
    if (taskIds.has(t.taskId)) return `Duplicate task taskId: ${t.taskId}`;
    taskIds.add(t.taskId);
    if (!EVENT_TASK_KINDS.includes(t.kind)) return `Task ${t.taskId} has invalid kind: ${t.kind}`;
    if (!Number.isInteger(t.target) || t.target <= 0) return `Task ${t.taskId} target must be a positive integer`;
    if (!Number.isInteger(t.points) || t.points <= 0) return `Task ${t.taskId} points must be a positive integer`;
  }

  const rewardIds = new Set<string>();
  for (const r of input.rewards) {
    if (!r.rewardId || typeof r.rewardId !== 'string') return 'Reward rewardId is required';
    if (rewardIds.has(r.rewardId)) return `Duplicate reward rewardId: ${r.rewardId}`;
    rewardIds.add(r.rewardId);
    if (!EVENT_REWARD_KINDS.includes(r.kind)) return `Reward ${r.rewardId} has invalid kind: ${r.kind}`;
    if (!Number.isInteger(r.cost) || r.cost < 0) return `Reward ${r.rewardId} cost must be a non-negative integer`;
    if (r.kind === 'coins') {
      if (!Number.isInteger(r.count) || (r.count ?? 0) <= 0) return `Reward ${r.rewardId} (coins) requires a positive integer count`;
    } else if (!r.id) {
      return `Reward ${r.rewardId} (${r.kind}) requires an id`;
    }
    if (r.maxClaims !== undefined && (!Number.isInteger(r.maxClaims) || r.maxClaims <= 0)) {
      return `Reward ${r.rewardId} maxClaims must be a positive integer`;
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
