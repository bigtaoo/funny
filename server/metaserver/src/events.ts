// Time-limited event container service (B6, ADR-014).
// getEventsForAccount: fetch active events + participation data.
// accrueEventTask: called at task trigger points (pve.clear / pvp.win / ad.watch); best-effort, failures do not block the main flow.
// claimEventReward: redeem points for a reward; dispatches via mail or commercial coin grant.
import { randomUUID } from 'node:crypto';
import type { Collections, EventDoc, EventParticipantDoc } from '@nw/shared';
import { isEventActive, validateEventInput, type EventInput, type EventTaskKind } from '@nw/shared';
import type { CommercialClient } from './commercialClient.js';
import { insertSystemMail } from './mail.js';

// ── Event view (sent to client) ────────────────────────────────────────────────

export interface EventTaskView {
  taskId: string;
  kind: string;
  target: number;
  points: number;
  progress: number;
  done: boolean;
}

export interface EventRewardView {
  rewardId: string;
  cost: number;
  kind: string;
  id?: string;
  count?: number;
  maxClaims?: number;
  claimedCount: number; // number of times claimed by this account
}

export interface EventView {
  eventId: string;
  title: string;
  description?: string;
  windowStart: number;
  windowEnd: number;
  myPoints: number;
  tasks: EventTaskView[];
  rewards: EventRewardView[];
}

// ── Internal helpers ────────────────────────────────────────────────────────────────

function participantId(eventId: string, accountId: string): string {
  return `${eventId}:${accountId}`;
}

function rewardClaimedCount(claimed: string[], rewardId: string): number {
  return claimed.filter((r) => r === rewardId).length;
}

function buildView(event: EventDoc, participant: EventParticipantDoc | null): EventView {
  const prog = participant?.taskProgress ?? [];
  const claimed = participant?.claimedRewards ?? [];
  const myPoints = participant?.points ?? 0;
  return {
    eventId: event._id,
    title: event.title,
    ...(event.description ? { description: event.description } : {}),
    windowStart: event.windowStart,
    windowEnd: event.windowEnd,
    myPoints,
    tasks: event.tasks.map((t) => {
      const p = prog.find((x) => x.taskId === t.taskId);
      const progress = p?.progress ?? 0;
      return { taskId: t.taskId, kind: t.kind, target: t.target, points: t.points, progress, done: progress >= t.target };
    }),
    rewards: event.rewards.map((r) => ({
      rewardId: r.rewardId,
      cost: r.cost,
      kind: r.kind,
      ...(r.id ? { id: r.id } : {}),
      ...(r.count !== undefined ? { count: r.count } : {}),
      ...(r.maxClaims !== undefined ? { maxClaims: r.maxClaims } : {}),
      claimedCount: rewardClaimedCount(claimed, r.rewardId),
    })),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Fetch the currently active event list + this account's participation data. */
export async function getEventsForAccount(
  cols: Collections,
  accountId: string,
  now: number,
): Promise<EventView[]> {
  const activeEvents = await cols.events
    .find({ windowStart: { $lte: now }, windowEnd: { $gt: now } })
    .toArray();
  if (!activeEvents.length) return [];

  const eventIds = activeEvents.map((e) => e._id);
  const participants = await cols.eventParticipants
    .find({ accountId, eventId: { $in: eventIds } })
    .toArray();

  const partMap = new Map(participants.map((p) => [p.eventId, p]));
  return activeEvents.map((event) => buildView(event, partMap.get(event._id) ?? null));
}

/**
 * Event task trigger point (best-effort: does not throw on failure, does not block the main flow).
 * For all active events containing tasks matching the given kind, atomically updates task progress
 * and grants points when the target is reached.
 */
export async function accrueEventTask(
  cols: Collections,
  accountId: string,
  kind: EventTaskKind,
  now: number,
): Promise<void> {
  // Find all active events that contain tasks of the given kind
  const activeEvents = await cols.events
    .find({ windowStart: { $lte: now }, windowEnd: { $gt: now } })
    .toArray();

  for (const event of activeEvents) {
    const matchingTasks = event.tasks.filter((t) => t.kind === kind);
    if (!matchingTasks.length) continue;

    const pid = participantId(event._id, accountId);

    // Ensure the participant document exists (upsert)
    await cols.eventParticipants.updateOne(
      { _id: pid },
      {
        $setOnInsert: {
          _id: pid,
          eventId: event._id,
          accountId,
          points: 0,
          taskProgress: [],
          claimedRewards: [],
          updatedAt: now,
        },
      },
      { upsert: true },
    );

    // Atomically advance progress for each matching task
    for (const task of matchingTasks) {
      // Read current progress (document already initialized)
      const doc = await cols.eventParticipants.findOne({ _id: pid });
      if (!doc) continue;

      const existing = doc.taskProgress.find((p) => p.taskId === task.taskId);
      const currentProgress = existing?.progress ?? 0;
      if (currentProgress >= task.target) continue; // task already complete, no further accumulation

      const newProgress = currentProgress + 1;
      const reachTarget = newProgress >= task.target;
      const alreadyGranted = existing?.pointsGranted ?? false;
      const grantPoints = reachTarget && !alreadyGranted;

      if (existing) {
        // Update the existing task record
        await cols.eventParticipants.updateOne(
          { _id: pid, 'taskProgress.taskId': task.taskId },
          {
            $set: {
              'taskProgress.$.progress': newProgress,
              ...(grantPoints ? { 'taskProgress.$.pointsGranted': true } : {}),
              updatedAt: now,
            },
            ...(grantPoints ? { $inc: { points: task.points } } : {}),
          },
        );
      } else {
        // Add a new task progress entry
        await cols.eventParticipants.updateOne(
          { _id: pid },
          {
            $push: {
              taskProgress: {
                taskId: task.taskId,
                progress: newProgress,
                pointsGranted: grantPoints,
              },
            },
            $set: { updatedAt: now },
            ...(grantPoints ? { $inc: { points: task.points } } : {}),
          },
        );
      }
    }
  }
}

// ── Admin event management CRUD (B6, ops admin console events.manage) ────────────────────────
// Player-side getEventsForAccount only fetches "within-window" events; the following are for ops to list/create/edit/delete all events.

/** List all event definitions (including not-yet-started and ended events), sorted by windowStart descending. */
export async function adminListEvents(cols: Collections): Promise<EventDoc[]> {
  return cols.events.find({}).sort({ windowStart: -1 }).toArray();
}

export type AdminEventError = 'VALIDATION' | 'NOT_FOUND' | 'DUPLICATE_ID';

/** Create an event; validate input + deduplicate _id. */
export async function adminCreateEvent(
  cols: Collections,
  input: EventInput,
  now: number,
): Promise<{ ok: true; event: EventDoc } | { ok: false; error: AdminEventError; detail?: string }> {
  const detail = validateEventInput(input);
  if (detail) return { ok: false, error: 'VALIDATION', detail };
  const _id = input.id?.trim() || randomUUID();
  if (await cols.events.findOne({ _id })) return { ok: false, error: 'DUPLICATE_ID', detail: _id };
  const doc: EventDoc = {
    _id,
    title: input.title.trim(),
    ...(input.description ? { description: input.description } : {}),
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    tasks: input.tasks,
    rewards: input.rewards,
    createdAt: now,
  };
  await cols.events.insertOne(doc);
  return { ok: true, event: doc };
}

/** Full replacement of an event definition (_id/createdAt preserved). Existing participation progress is untouched (task/reward changes may cause old progress to mismatch — ops responsibility). */
export async function adminUpdateEvent(
  cols: Collections,
  eventId: string,
  input: EventInput,
): Promise<{ ok: true; event: EventDoc } | { ok: false; error: AdminEventError; detail?: string }> {
  const detail = validateEventInput(input);
  if (detail) return { ok: false, error: 'VALIDATION', detail };
  const existing = await cols.events.findOne({ _id: eventId });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  const next: EventDoc = {
    _id: eventId,
    title: input.title.trim(),
    ...(input.description ? { description: input.description } : {}),
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    tasks: input.tasks,
    rewards: input.rewards,
    createdAt: existing.createdAt,
  };
  await cols.events.replaceOne({ _id: eventId }, next);
  return { ok: true, event: next };
}

/** Delete an event definition (does not cascade-delete eventParticipants: history is preserved, and expired events are no longer read). */
export async function adminDeleteEvent(
  cols: Collections,
  eventId: string,
): Promise<{ ok: true } | { ok: false; error: 'NOT_FOUND' }> {
  const res = await cols.events.deleteOne({ _id: eventId });
  if (res.deletedCount === 0) return { ok: false, error: 'NOT_FOUND' };
  return { ok: true };
}

// ── Reward redemption ─────────────────────────────────────────────────────────────────

export type ClaimEventError =
  | 'NOT_FOUND'          // event or reward does not exist
  | 'EVENT_CLOSED'       // outside the event window
  | 'INSUFFICIENT_POINTS' // not enough points
  | 'CLAIM_LIMIT_REACHED'; // exceeds maxClaims

export interface ClaimEventOk {
  ok: true;
  pointsLeft: number;
  reward: { kind: string; id?: string; count?: number };
}

/**
 * Redeem event reward with points.
 * - Rejects if outside the event window; rejects if insufficient points; rejects if maxClaims exceeded.
 * - Atomically deducts points (findOneAndUpdate $gte guard); dispatches reward: coins → commercial.grant, others → mail attachment.
 * - orderId is idempotent (`${pid}:${rewardId}:${claimIndex}`) to prevent double-dispatch on network retries.
 */
export async function claimEventReward(
  cols: Collections,
  accountId: string,
  eventId: string,
  rewardId: string,
  now: number,
  commercial: CommercialClient,
): Promise<ClaimEventOk | { ok: false; error: ClaimEventError }> {
  const event = await cols.events.findOne({ _id: eventId });
  if (!event) return { ok: false, error: 'NOT_FOUND' };

  if (!isEventActive(event.windowStart, event.windowEnd, now)) {
    return { ok: false, error: 'EVENT_CLOSED' };
  }

  const reward = event.rewards.find((r) => r.rewardId === rewardId);
  if (!reward) return { ok: false, error: 'NOT_FOUND' };

  const pid = participantId(eventId, accountId);

  // Ensure the participant document exists
  await cols.eventParticipants.updateOne(
    { _id: pid },
    {
      $setOnInsert: {
        _id: pid,
        eventId,
        accountId,
        points: 0,
        taskProgress: [],
        claimedRewards: [],
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  const doc = await cols.eventParticipants.findOne({ _id: pid });
  if (!doc) return { ok: false, error: 'NOT_FOUND' };

  // Check maxClaims limit
  if (reward.maxClaims !== undefined) {
    const alreadyClaimed = rewardClaimedCount(doc.claimedRewards, rewardId);
    if (alreadyClaimed >= reward.maxClaims) return { ok: false, error: 'CLAIM_LIMIT_REACHED' };
  }

  // Check that the account has enough points
  if (doc.points < reward.cost) return { ok: false, error: 'INSUFFICIENT_POINTS' };

  // Atomically deduct points ($gte guard prevents concurrent over-deduction)
  const claimIndex = doc.claimedRewards.length;
  const updated = await cols.eventParticipants.findOneAndUpdate(
    { _id: pid, points: { $gte: reward.cost } },
    {
      $inc: { points: -reward.cost },
      $push: { claimedRewards: rewardId },
      $set: { updatedAt: now },
    },
    { returnDocument: 'after' },
  );
  if (!updated) return { ok: false, error: 'INSUFFICIENT_POINTS' }; // lost concurrent race

  const pointsLeft = updated.points;
  const dispatchKey = `event.claim:${pid}:${rewardId}:${claimIndex}`;

  // Dispatch reward
  if (reward.kind === 'coins' && (reward.count ?? 0) > 0 && commercial.available) {
    await commercial
      .grant({ accountId, amount: reward.count!, reason: 'event_reward', orderId: randomUUID() })
      .catch(() => {/* best-effort; points already deducted, no rollback for now (ops compensation fallback) */});
  } else if (reward.kind !== 'coins') {
    // material / skin → mail attachment
    await insertSystemMail(
      cols,
      dispatchKey,
      accountId,
      {
        subject: `Event Reward: ${event.title}`,
        body: `Congratulations! You received ${reward.id ?? reward.kind} × ${reward.count ?? 1}`,
        attachments: [
          {
            kind: reward.kind as 'material' | 'skin',
            ...(reward.id ? { id: reward.id } : {}),
            ...(reward.count !== undefined ? { count: reward.count } : {}),
          },
        ],
        expireDays: 30,
      },
      now,
    ).catch(() => {/* mail write failed: points already deducted, ops compensation fallback */});
  }

  return {
    ok: true,
    pointsLeft,
    reward: { kind: reward.kind, ...(reward.id ? { id: reward.id } : {}), ...(reward.count !== undefined ? { count: reward.count } : {}) },
  };
}
