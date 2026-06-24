// 限时活动容器机制单一来源（B6，ADR-014）。
// 纯数据 + 纯函数，无 DB；服务端/客户端同用。

// ── 活动任务种类 ─────────────────────────────────────────────────────────────

/** 活动任务触发种类（对应服务端可钩挂的事件来源）。 */
export type EventTaskKind = 'pve.clear' | 'pvp.win' | 'ad.watch';

// ── 活动定义结构（存于 Mongo events 集合，admin 写入）──────────────────────

export interface EventTaskDef {
  /** 任务局部 id（活动内唯一，非全局 statKey）。 */
  taskId: string;
  /** 触发来源：与服务端钩点一一对应。 */
  kind: EventTaskKind;
  /** 完成所需触发次数。 */
  target: number;
  /** 完成后获得的活动积分。 */
  points: number;
}

export interface EventRewardDef {
  rewardId: string;
  /** 兑换所需积分。 */
  cost: number;
  /** 奖励种类（发奖走邮件附件 / commercial 金币）。 */
  kind: 'coins' | 'material' | 'skin';
  /** material/skin 的 id（coins 无需）。 */
  id?: string;
  /** 数量（coins 的面额 / 材料数量）。 */
  count?: number;
  /** 每账号最多领取次数；undefined = 不限。 */
  maxClaims?: number;
}

// ── 参与数据（存于 Mongo eventParticipants 集合，per-account per-event）──

export interface EventTaskProgress {
  taskId: string;
  /** 已触发次数（单调递增，不超过 target）。 */
  progress: number;
  /** 是否已获得本任务积分（幂等闸：满足 progress≥target 且未领过才 $inc points）。 */
  pointsGranted: boolean;
}

// ── admin 写入入参 + 校验（运维后台创建/编辑活动用）──────────────────────────

/** 合法任务种类（与 EventTaskKind 同源，供 admin 校验/前端下拉）。 */
export const EVENT_TASK_KINDS: readonly EventTaskKind[] = ['pve.clear', 'pvp.win', 'ad.watch'];
/** 合法奖励种类。 */
export const EVENT_REWARD_KINDS: readonly EventRewardDef['kind'][] = ['coins', 'material', 'skin'];

/** 创建/编辑活动入参（_id/createdAt 由服务端补；id 可选指定 _id）。 */
export interface EventInput {
  /** 指定 eventId（运营自定义；缺省则服务端生成 UUID）。 */
  id?: string;
  title: string;
  description?: string;
  windowStart: number;
  windowEnd: number;
  tasks: EventTaskDef[];
  rewards: EventRewardDef[];
}

/**
 * 校验活动入参，合法返回 null，否则返回错误说明（脏数据进库会让结算/兑换抛错）。
 * 服务端写库前必调；前端可同源调一遍做即时提示。
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

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 活动窗口是否有效（[windowStart, windowEnd) 区间）。 */
export function isEventActive(windowStart: number, windowEnd: number, now: number): boolean {
  return now >= windowStart && now < windowEnd;
}

/** 某任务在当前参与记录中的完成进度；缺省 = 0。 */
export function taskProgress(prog: EventTaskProgress[], taskId: string): number {
  return prog.find((p) => p.taskId === taskId)?.progress ?? 0;
}

/** 某奖励已领次数（参与记录 claimedRewards 是列表，重复领可多次）。 */
export function rewardClaimedCount(claimed: string[], rewardId: string): number {
  return claimed.filter((r) => r === rewardId).length;
}
