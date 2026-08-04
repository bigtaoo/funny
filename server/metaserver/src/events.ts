// Time-limited event container service (B6, ADR-014).
// getEventsForAccount: fetch active events + participation data.
// accrueEventTask: called at task trigger points (pve.clear / pvp.win / ad.watch); best-effort, failures do not block the main flow.
// claimEventReward: redeem points for a reward; dispatches via mail or commercial coin grant.
import { randomUUID } from 'node:crypto';
import type { Collections, EventDoc, EventParticipantDoc } from '@nw/shared';
import { isEventActive, validateEventInput, type EventInput, type EventTaskKind } from '@nw/shared';
import type { CommercialClient } from './commercialClient.js';
import { insertSystemMail } from './mail.js';
import type { MetaSocialsvcClient } from './socialsvcClient.js';

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

    // Atomically advance progress for each matching task. Every write below is a single
    // conditional Mongo operation whose filter re-checks the value it's about to change, so
    // concurrent triggers (e.g. two fast pve/pvp/ad callbacks racing) can't lose an increment
    // or double-grant points — Mongo serializes per-document writes, and a losing racer's filter
    // simply stops matching once the winner's write has landed.
    for (const task of matchingTasks) {
      // First trigger for this task: push a fresh progress entry, but only if one doesn't already
      // exist (query is evaluated atomically against the current document at write time).
      const pushRes = await cols.eventParticipants.updateOne(
        { _id: pid, 'taskProgress.taskId': { $ne: task.taskId } },
        {
          $push: { taskProgress: { taskId: task.taskId, progress: 1, pointsGranted: false } },
          $set: { updatedAt: now },
        },
      );

      let newProgress: number;
      if (pushRes.modifiedCount === 1) {
        newProgress = 1;
      } else {
        // An entry already existed (this call, or a racing one, got there first) — advance it by
        // exactly one, guarded so it can never step past target.
        const incRes = await cols.eventParticipants.findOneAndUpdate(
          { _id: pid, taskProgress: { $elemMatch: { taskId: task.taskId, progress: { $lt: task.target } } } },
          { $inc: { 'taskProgress.$.progress': 1 }, $set: { updatedAt: now } },
          { returnDocument: 'after' },
        );
        if (!incRes) continue; // task already complete, no further accumulation
        newProgress = incRes.taskProgress.find((p) => p.taskId === task.taskId)?.progress ?? task.target;
      }

      if (newProgress >= task.target) {
        // Grant points exactly once: the filter only matches while pointsGranted is still false.
        await cols.eventParticipants.updateOne(
          { _id: pid, taskProgress: { $elemMatch: { taskId: task.taskId, pointsGranted: { $ne: true } } } },
          {
            $set: { 'taskProgress.$.pointsGranted': true, updatedAt: now },
            $inc: { points: task.points },
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
  socialsvc: MetaSocialsvcClient,
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

  // Fast, friendly pre-checks for the common (non-racing) case. They are NOT the actual guard — both are
  // re-checked atomically in the write below, because a concurrent claim can slip in between these reads
  // and that write.
  if (reward.maxClaims !== undefined) {
    const alreadyClaimed = rewardClaimedCount(doc.claimedRewards, rewardId);
    if (alreadyClaimed >= reward.maxClaims) return { ok: false, error: 'CLAIM_LIMIT_REACHED' };
  }
  if (doc.points < reward.cost) return { ok: false, error: 'INSUFFICIENT_POINTS' };

  // Atomic guard: points AND (when capped) the claim-count are both re-checked in the SAME update filter, so
  // two concurrent claims for a maxClaims-limited reward cannot both pass — the $expr counts matching entries
  // in claimedRewards live against the current document, not the stale `doc` read above.
  const filter: Record<string, unknown> = { _id: pid, points: { $gte: reward.cost } };
  if (reward.maxClaims !== undefined) {
    filter.$expr = {
      $lt: [
        { $size: { $filter: { input: { $ifNull: ['$claimedRewards', []] }, cond: { $eq: ['$$this', rewardId] } } } },
        reward.maxClaims,
      ],
    };
  }
  const updated = await cols.eventParticipants.findOneAndUpdate(
    filter,
    {
      $inc: { points: -reward.cost },
      $push: { claimedRewards: rewardId },
      $set: { updatedAt: now },
    },
    { returnDocument: 'after' },
  );
  if (!updated) {
    // Lost a concurrent race — re-read to report which guard actually failed.
    const cur = await cols.eventParticipants.findOne({ _id: pid });
    if (reward.maxClaims !== undefined && rewardClaimedCount(cur?.claimedRewards ?? [], rewardId) >= reward.maxClaims) {
      return { ok: false, error: 'CLAIM_LIMIT_REACHED' };
    }
    return { ok: false, error: 'INSUFFICIENT_POINTS' };
  }

  const pointsLeft = updated.points;
  // Index from the POST-commit array (not a pre-read length): under a concurrent race for a maxClaims>1
  // reward, two claims can both legitimately succeed, and each must land its own unique index — a pre-read
  // length would let both compute the same index and collide on dispatchKey/orderId.
  const claimIndex = updated.claimedRewards.length - 1;
  const dispatchKey = `event.claim:${pid}:${rewardId}:${claimIndex}`;

  // Dispatch reward
  if (reward.kind === 'coins' && (reward.count ?? 0) > 0 && commercial.available) {
    await commercial
      .grant({ accountId, amount: reward.count!, reason: 'event_reward', orderId: dispatchKey })
      .catch(() => {/* best-effort; points already deducted, no rollback for now (ops compensation fallback) */});
  } else if (reward.kind !== 'coins') {
    // material / skin → mail attachment
    await insertSystemMail(
      socialsvc,
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
    ).catch(() => {/* mail write failed: points already deducted, ops compensation fallback */});
  }

  return {
    ok: true,
    pointsLeft,
    reward: { kind: reward.kind, ...(reward.id ? { id: reward.id } : {}), ...(reward.count !== undefined ? { count: reward.count } : {}) },
  };
}
