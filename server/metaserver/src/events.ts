// 限时活动容器服务（B6，ADR-014）。
// getEventsForAccount: 拉取有效活动 + 参与数据。
// accrueEventTask: 任务触发点（pve.clear / pvp.win / ad.watch）调用；best-effort，失败不阻主流程。
// claimEventReward: 积分兑换奖励，发奖走邮件 / commercial 金币。
import { randomUUID } from 'node:crypto';
import type { Collections, EventDoc, EventParticipantDoc } from '@nw/shared';
import { isEventActive, validateEventInput, type EventInput, type EventTaskKind } from '@nw/shared';
import type { CommercialClient } from './commercialClient.js';
import { insertSystemMail } from './mail.js';

// ── 活动视图（下发给客户端）────────────────────────────────────────────────

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
  claimedCount: number; // 本账号已领次数
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

// ── 内部辅助 ────────────────────────────────────────────────────────────────

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

// ── 公开 API ─────────────────────────────────────────────────────────────────

/** 拉取当前有效活动列表 + 本账号参与数据。 */
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
 * 活动任务触发点（best-effort：失败不抛、不阻主流程）。
 * 对 kind 匹配的所有有效活动，各原子更新任务进度，满足条件时发积分。
 */
export async function accrueEventTask(
  cols: Collections,
  accountId: string,
  kind: EventTaskKind,
  now: number,
): Promise<void> {
  // 找到有效活动中包含该 kind 任务的所有定义
  const activeEvents = await cols.events
    .find({ windowStart: { $lte: now }, windowEnd: { $gt: now } })
    .toArray();

  for (const event of activeEvents) {
    const matchingTasks = event.tasks.filter((t) => t.kind === kind);
    if (!matchingTasks.length) continue;

    const pid = participantId(event._id, accountId);

    // 确保文档存在（upsert）
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

    // 对每个匹配任务原子推进进度
    for (const task of matchingTasks) {
      // 读取当前进度（已初始化）
      const doc = await cols.eventParticipants.findOne({ _id: pid });
      if (!doc) continue;

      const existing = doc.taskProgress.find((p) => p.taskId === task.taskId);
      const currentProgress = existing?.progress ?? 0;
      if (currentProgress >= task.target) continue; // 任务已满，不再累计

      const newProgress = currentProgress + 1;
      const reachTarget = newProgress >= task.target;
      const alreadyGranted = existing?.pointsGranted ?? false;
      const grantPoints = reachTarget && !alreadyGranted;

      if (existing) {
        // 更新已有任务记录
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
        // 新增任务进度条目
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

// ── admin 活动管理 CRUD（B6，运维后台 events.manage）────────────────────────
// 玩家侧 getEventsForAccount 只拉「窗口内」活动；以下供运维列出/创建/编辑/删除全部活动。

/** 列出全部活动定义（含未开始/已结束），按开始时间倒序。 */
export async function adminListEvents(cols: Collections): Promise<EventDoc[]> {
  return cols.events.find({}).sort({ windowStart: -1 }).toArray();
}

export type AdminEventError = 'VALIDATION' | 'NOT_FOUND' | 'DUPLICATE_ID';

/** 创建活动；校验入参 + _id 去重。 */
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

/** 全量替换活动定义（_id/createdAt 保持）。已产生的参与进度不动（task/reward 改动可能让旧进度对不上，运营自负）。 */
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

/** 删除活动定义（不级联删 eventParticipants：保留历史，且过期活动不再被读取）。 */
export async function adminDeleteEvent(
  cols: Collections,
  eventId: string,
): Promise<{ ok: true } | { ok: false; error: 'NOT_FOUND' }> {
  const res = await cols.events.deleteOne({ _id: eventId });
  if (res.deletedCount === 0) return { ok: false, error: 'NOT_FOUND' };
  return { ok: true };
}

// ── 奖励兑换 ─────────────────────────────────────────────────────────────────

export type ClaimEventError =
  | 'NOT_FOUND'          // 活动或奖励不存在
  | 'EVENT_CLOSED'       // 活动窗口外
  | 'INSUFFICIENT_POINTS' // 积分不足
  | 'CLAIM_LIMIT_REACHED'; // 超出 maxClaims

export interface ClaimEventOk {
  ok: true;
  pointsLeft: number;
  reward: { kind: string; id?: string; count?: number };
}

/**
 * 积分兑换活动奖励。
 * - 活动期外拒绝；积分不足拒绝；maxClaims 超限拒绝。
 * - 原子扣分（findOneAndUpdate $gte guard）；发奖：coins → commercial.grant，其余 → 邮件附件。
 * - orderId 幂等（`${pid}:${rewardId}:${claimIndex}`），防网络重试双发。
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

  // 确保文档存在
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

  // 检查 maxClaims
  if (reward.maxClaims !== undefined) {
    const alreadyClaimed = rewardClaimedCount(doc.claimedRewards, rewardId);
    if (alreadyClaimed >= reward.maxClaims) return { ok: false, error: 'CLAIM_LIMIT_REACHED' };
  }

  // 检查积分充足
  if (doc.points < reward.cost) return { ok: false, error: 'INSUFFICIENT_POINTS' };

  // 原子扣分（$gte 守卫防并发超扣）
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
  if (!updated) return { ok: false, error: 'INSUFFICIENT_POINTS' }; // 并发竞争落败

  const pointsLeft = updated.points;
  const dispatchKey = `event.claim:${pid}:${rewardId}:${claimIndex}`;

  // 发奖
  if (reward.kind === 'coins' && (reward.count ?? 0) > 0 && commercial.available) {
    await commercial
      .grant({ accountId, amount: reward.count!, reason: 'event_reward', orderId: randomUUID() })
      .catch(() => {/* best-effort；已扣分，暂不回滚（运营补偿兜底） */});
  } else if (reward.kind !== 'coins') {
    // material / skin → 邮件附件
    await insertSystemMail(
      cols,
      dispatchKey,
      accountId,
      {
        subject: `活动奖励：${event.title}`,
        body: `恭喜获得 ${reward.id ?? reward.kind} × ${reward.count ?? 1}`,
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
    ).catch(() => {/* 邮件写入失败：已扣分，运营补偿兜底 */});
  }

  return {
    ok: true,
    pointsLeft,
    reward: { kind: reward.kind, ...(reward.id ? { id: reward.id } : {}), ...(reward.count !== undefined ? { count: reward.count } : {}) },
  };
}
