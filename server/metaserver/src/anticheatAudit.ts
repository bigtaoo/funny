// 成就 PvP 统计反作弊 L2/L3 离线抽查批（ACHIEVEMENT_DESIGN §4.4）。meta 定时器周期调 auditOnce：
// 抽取已归档 ranked 局 → 经在线 peer 裁判（gateway.judge）无头复算双方真实 kill/cast →
// 与归档的上报值比对 → 实锤超报则回滚超报量 + 升 statSuspicion + 入 OPS 审查队列。
//
// 关键约束：服务器把指令帧存为 base64 opaque、永不解码，故复算**必须**经 peer 裁判（同 Phase C）。
// 无裁判可用 / 复算失败 / 旧引擎 → 跳过（benefit-of-doubt，绝不无据定罪）。纯逻辑（抽样/比对/回滚）
// 在 @nw/shared.antiCheatAudit，本文件只做编排 + DB。
import type {
  Collections,
  MatchDoc,
  SaveData,
  StatKey,
  AntiCheatReviewDoc,
} from '@nw/shared';
import {
  compareAudit,
  applyRollback,
  shouldAuditSample,
} from '@nw/shared';
import type { GatewayClient, JudgeFrame } from './gatewayClient.js';
import { createLogger } from '@nw/shared';

const log = createLogger('meta:anticheat-audit');

export interface AuditDeps {
  cols: Collections;
  /** 复算源（Phase C 同款）。`available=false` → 整批跳过（无裁判绝不定罪）。 */
  gateway: GatewayClient;
  now: () => number;
  /** 0..1 随机数（注入便于测试确定性）；缺省 Math.random。 */
  rand?: () => number;
  /** 每 tick 检视的候选局数（缺省 5，最旧优先 drain backlog）。 */
  sampleLimit?: number;
  /** 抽样概率覆盖（缺省 AUDIT_SAMPLE_P0 / AUDIT_SAMPLE_P_FLAGGED）。 */
  p0?: number;
  pFlagged?: number;
}

export interface AuditResult {
  examined: number; // 取出的候选局数
  audited: number; // 打了 audited 标记的局（clean + overclaim）
  flagged: number; // 实锤超报的方数（升档 + 回滚 + 审查记录）
  skipped: number; // 无录像 / 复算失败 → skipped 标记
}

/** 解析裁判 PvP per-side statsJson → `{ side号: {statKey:n} }`；非法 → null。 */
function parsePerSideStats(
  statsJson: string | undefined,
): Record<string, Partial<Record<StatKey, number>>> | null {
  if (!statsJson) return null;
  try {
    const o = JSON.parse(statsJson) as unknown;
    if (!o || typeof o !== 'object') return null;
    return o as Record<string, Partial<Record<StatKey, number>>>;
  } catch {
    return null;
  }
}

/** 归档录像帧（commands 已是 base64 字符串）→ 裁判帧。 */
function toJudgeFrames(doc: MatchDoc): JudgeFrame[] {
  const replay = doc.replay;
  if (!replay) return [];
  return replay.frames.map((f) => ({
    frame: f.frame,
    cmds: f.cmds.map((c) => ({ side: c.side, commands: String(c.commands) })),
  }));
}

/** 乐观锁读-改-写存档（同 service.mutateSave / applyPvp，3 次重试）。失败返回 null。 */
async function mutateSaveForAudit(
  cols: Collections,
  now: () => number,
  accountId: string,
  transform: (s: SaveData) => SaveData,
): Promise<SaveData | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return null;
    const out = transform(doc.save);
    const next: SaveData = { ...out, rev: doc.save.rev + 1, updatedAt: now() };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
      { returnDocument: 'after' },
    );
    if (res) return res.save;
  }
  return null;
}

/** 打 audited 标记（幂等闸；仅在仍无标记时写）。 */
async function markAudited(
  cols: Collections,
  roomId: string,
  audited: MatchDoc['audited'],
): Promise<void> {
  await cols.matches
    .updateOne({ roomId, audited: { $exists: false } }, { $set: { audited } })
    .catch((e) => log.error('mark audited failed', { roomId, err: (e as Error).message }));
}

/**
 * 抽查一批已归档 ranked 局。无裁判可用直接全 0 返回；逐局**串行**复算（每局一次在线复算，
 * 避免压垮实时对局）。任一步异常只记日志、不打标记（保持再抽资格），不抛。
 */
export async function auditOnce(deps: AuditDeps): Promise<AuditResult> {
  const { cols, gateway, now } = deps;
  const result: AuditResult = { examined: 0, audited: 0, flagged: 0, skipped: 0 };
  if (!gateway.available) return result; // 无裁判 → 绝不定罪

  const rand = deps.rand ?? Math.random;
  const limit = deps.sampleLimit ?? 5;
  const opts = { p0: deps.p0, pFlagged: deps.pFlagged };

  const candidates = await cols.matches
    .find({ mode: 'ranked', audited: { $exists: false } })
    .sort({ ts: 1 }) // 最旧优先，drain backlog
    .limit(limit)
    .toArray();
  result.examined = candidates.length;

  for (const doc of candidates) {
    try {
      await auditMatch(deps, doc, rand, opts, result);
    } catch (e) {
      log.error('audit match failed', { roomId: doc.roomId, err: (e as Error).message });
      // 不打标记 → 留局再抽（不丢数据）。
    }
  }
  return result;
}

async function auditMatch(
  deps: AuditDeps,
  doc: MatchDoc,
  rand: () => number,
  opts: { p0?: number; pFlagged?: number },
  result: AuditResult,
): Promise<void> {
  const { cols, gateway, now } = deps;

  // L3 加权抽样：取参战双方 statSuspicion 较大值喂抽样判定（任一方 flagged 即抬高整局被抽概率）。
  const saves = await Promise.all(
    doc.players.map((p) => cols.saves.findOne({ _id: p.accountId })),
  );
  const maxSusp = saves.reduce((m, s) => Math.max(m, s?.save.antiCheat?.statSuspicion ?? 0), 0);
  if (!shouldAuditSample(maxSusp, rand(), opts)) return; // 未抽中：不打标记，保留再抽资格

  // 取录像（内嵌优先，回退外置 blob）。
  let replay = doc.replay;
  if (!replay && doc.replayRef) {
    const blob = await cols.replayBlobs.findOne({ _id: doc.replayRef });
    replay = blob?.replay;
  }
  if (!replay) {
    await markAudited(cols, doc.roomId, { ts: now(), verdict: 'skipped' });
    result.audited++;
    result.skipped++;
    return;
  }

  // 经 peer 裁判无头复算（mode 1 = ranked；帧 base64 原样转交，同 judgeMismatch）。
  const verdict = await gateway.judge({
    seed: Number(doc.seed),
    mode: 1,
    endFrame: replay.endFrame,
    frames: toJudgeFrames({ ...doc, replay }),
    exclude: doc.players.map((p) => p.accountId),
  });
  const parsed = verdict.ok ? parsePerSideStats(verdict.statsJson) : null;
  if (!verdict.ok || !parsed) {
    // 无裁判可裁 / 复算失败 / 旧引擎不可复算 → 标 skipped（消费掉，不无限重试坏录像）。
    await markAudited(cols, doc.roomId, {
      ts: now(),
      verdict: 'skipped',
      ...(verdict.judgeAccountId ? { judgeAccountId: verdict.judgeAccountId } : {}),
    });
    result.audited++;
    result.skipped++;
    return;
  }

  // 逐方比对上报 vs 复算，收集超报方。
  const overclaimBySide: Record<string, Partial<Record<StatKey, number>>> = {};
  for (const p of doc.players) {
    const reported = doc.reportedStats?.[String(p.side)];
    const authoritative = parsed[String(p.side)];
    const cmp = compareAudit(reported, authoritative);
    if (!cmp.suspicious) continue;
    const rolled = await flagOverclaim(deps, doc, p, reported ?? {}, authoritative ?? {}, cmp.overclaim, verdict.judgeAccountId);
    if (rolled) {
      overclaimBySide[String(p.side)] = rolled;
      result.flagged++;
    }
  }

  const suspicious = Object.keys(overclaimBySide).length > 0;
  await markAudited(cols, doc.roomId, {
    ts: now(),
    verdict: suspicious ? 'overclaim' : 'clean',
    ...(verdict.judgeAccountId ? { judgeAccountId: verdict.judgeAccountId } : {}),
    ...(suspicious ? { overclaim: overclaimBySide } : {}),
  });
  result.audited++;
}

/**
 * 实锤某方超报：review-first 作锁（`_id=roomId:accountId` 唯一）防重复回滚——
 * 已存在说明上轮已回滚过则跳过。新插入 → 回滚超报量（0 下限钳制）+ statSuspicion++ + lastFlaggedTs，
 * 再回填实际回滚量/升档后值。返回实际回滚量；已处理过 / 回滚写失败 → null（不计 flagged）。
 */
async function flagOverclaim(
  deps: AuditDeps,
  doc: MatchDoc,
  player: MatchDoc['players'][number],
  reported: Partial<Record<StatKey, number>>,
  authoritative: Partial<Record<StatKey, number>>,
  overclaim: Partial<Record<StatKey, number>>,
  judgeAccountId: string | undefined,
): Promise<Partial<Record<StatKey, number>> | null> {
  const { cols, now } = deps;
  const reviewId = `${doc.roomId}:${player.accountId}`;

  // review-first 作幂等锁：唯一索引（_id）抢占，已存在 → 上轮已回滚，跳过。
  const seed: AntiCheatReviewDoc = {
    _id: reviewId,
    roomId: doc.roomId,
    accountId: player.accountId,
    ...(player.publicId ? { publicId: player.publicId } : {}),
    side: player.side,
    reported,
    authoritative,
    overclaim,
    rolledBack: {},
    suspicionAfter: 0,
    status: 'open',
    ts: now(),
    ...(judgeAccountId ? { judgeAccountId } : {}),
  };
  try {
    await cols.antiCheatReviews.insertOne(seed);
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return null; // 已处理过该局该方
    throw e;
  }

  // 回滚超报量 + 升档（rev 守卫原子写）。金币不追回（§4.4）——只改 stats + antiCheat。
  let rolledBack: Partial<Record<StatKey, number>> = {};
  let suspicionAfter = 0;
  const saved = await mutateSaveForAudit(cols, now, player.accountId, (s) => {
    const { stats, rolledBack: rb } = applyRollback(s.stats, overclaim);
    rolledBack = rb;
    const prevSusp = s.antiCheat?.statSuspicion ?? 0;
    suspicionAfter = prevSusp + 1;
    return {
      ...s,
      ...(stats ? { stats } : {}),
      antiCheat: { statSuspicion: suspicionAfter, lastFlaggedTs: now() },
    };
  });
  if (!saved) {
    // 回滚写失败（rev 冲突重试耗尽）：删回 review 解锁，留局下轮再抽（不丢数据）。
    await cols.antiCheatReviews.deleteOne({ _id: reviewId }).catch(() => {});
    return null;
  }

  await cols.antiCheatReviews
    .updateOne({ _id: reviewId }, { $set: { rolledBack, suspicionAfter } })
    .catch((e) => log.error('review backfill failed', { reviewId, err: (e as Error).message }));

  log.warn('anti-cheat overclaim flagged', {
    roomId: doc.roomId,
    accountId: player.accountId,
    overclaim,
    rolledBack,
    suspicionAfter,
  });
  return rolledBack;
}
