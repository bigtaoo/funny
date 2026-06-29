// 天梯赛季服务（S11，SEASON_DESIGN.md §3-4）。
// 赛季时钟懒创建、惰性迁移（migrateIfStale）、赛季结算（settleSeasonForPlayer）。
import type { Collections, SaveData, SaveDoc } from '@nw/shared';
import {
  SEASON_DURATION_MS,
  SEASON_RESET_BASELINE,
  softReset,
  seasonPeakCoins,
  makePvpSeasonDefaults,
  eloToRank,
  pendingBpRewards,
  makeFreshBattlePass,
  ladderTitleId,
  type LadderSeasonDoc,
  type RankId,
  createLogger,
} from '@nw/shared';
import type { CommercialClient } from './commercialClient.js';
import { insertSystemMail } from './mail.js';
import { grantTitleToPlayer } from './titles.js';

const log = createLogger('meta:ladderSeason');

/** 邮件保留天数（赛季结算奖励邮件）。 */
const SETTLE_MAIL_EXPIRE_DAYS = 30;

// ── 赛季时钟 ─────────────────────────────────────────────────────────────────

/**
 * 读取当前赛季文档，不存在则懒创建赛季 #1。
 * 所有赛季入口都经此函数，保证全局单文档存在。
 */
export async function getCurrentSeason(
  cols: Collections,
  now: number,
): Promise<LadderSeasonDoc> {
  const doc = await cols.ladderSeasons.findOne({ _id: 'current' });
  if (doc) return doc;
  // 首次启动：懒创建赛季 #1
  const fresh: LadderSeasonDoc = {
    _id: 'current',
    seasonNo: 1,
    startAt: now,
    endAt: now + SEASON_DURATION_MS,
    state: 'active',
  };
  await cols.ladderSeasons.updateOne(
    { _id: 'current' },
    { $setOnInsert: fresh },
    { upsert: true },
  );
  return (await cols.ladderSeasons.findOne({ _id: 'current' })) ?? fresh;
}

/**
 * 收束当前赛季并开启下一赛季（admin 手动触发，`POST /admin/ladder/season/roll`）。
 * 闭环（L2-1）：CAS 进入 settling 后，先主动结算上一季全部参与者（发段位奖励邮件 + 授予赛季称号 +
 * 写结算快照），再把赛季时钟推进到下一季。这样不再有玩家「不回归就拿不到赛季奖」的断裂链路。
 *
 * CAS 幂等：只有 state='active' 时才推进（防运维连点两次的并发窗口）。结算本身经
 * settleSeasonParticipants 三重幂等，与惰性迁移并行执行也不会双发。
 * @returns 新的赛季文档，若已在 settling/不存在则返回当前文档。
 */
export async function rollSeason(
  cols: Collections,
  commercial: CommercialClient,
  now: number,
): Promise<LadderSeasonDoc> {
  // CAS：仅 state=active 时推进
  const res = await cols.ladderSeasons.findOneAndUpdate(
    { _id: 'current', state: 'active' },
    { $set: { state: 'settling' } },
    { returnDocument: 'before' },
  );
  if (!res) {
    // 已在 settling 或不存在 → 直接返回当前状态
    return getCurrentSeason(cols, now);
  }
  const prev = res;

  // 闭环结算：在推进时钟之前结清上一季所有参与者（幂等，失败不阻断推进——单玩家失败已内部吞掉日志，
  // 漏结的玩家回归时仍由 migrateIfStale 惰性补结，同样幂等）。
  await settleSeasonParticipants(cols, commercial, prev.seasonNo, now).catch((e) =>
    log.error('rollSeason: settle participants failed', { seasonNo: prev.seasonNo, err: (e as Error).message }),
  );

  const newDoc: LadderSeasonDoc = {
    _id: 'current',
    seasonNo: prev.seasonNo + 1,
    startAt: now,
    endAt: now + SEASON_DURATION_MS,
    state: 'active',
  };
  await cols.ladderSeasons.replaceOne({ _id: 'current' }, newDoc);
  log.info('ladder season rolled', { from: prev.seasonNo, to: newDoc.seasonNo });
  return newDoc;
}

// ── 赛季结算（惰性，每次迁移只发一次）────────────────────────────────────────

/**
 * 对单个玩家发放「上赛季峰值奖励」，走系统邮件（异步/有仪式感/可审计）。
 * 幂等：dispatchKey = `ladder.season.${prevSeasonNo}.${accountId}` 去重。
 * 段位称号（S10）：通过 grantTitleToPlayer 幂等授予（见下方调用，best-effort）。
 * 同时补发未领战令奖励（§9，S6 温和）。
 */
export async function settleSeasonForPlayer(
  cols: Collections,
  commercial: CommercialClient,
  accountId: string,
  save: SaveData,
  prevSeasonNo: number,
  now: number,
): Promise<SeasonSettleSummary> {
  const peakRank = (save.pvp.seasonPeakRank ?? eloToRank(save.pvp.seasonPeakElo ?? save.pvp.elo)) as RankId;
  const peakElo = save.pvp.seasonPeakElo ?? save.pvp.elo;
  const coins = seasonPeakCoins(peakRank);
  const titleId = ladderTitleId(prevSeasonNo, peakRank);

  // 战令补发（温和，S6：已挣未领不没收）
  const bpPending = save.battlePass ? pendingBpRewards(save.battlePass) : [];
  const bpCoins = bpPending
    .filter((r) => r.reward.kind === 'coins')
    .reduce((s, r) => s + r.reward.count, 0);
  const totalCoins = coins + bpCoins;

  // 授予赛季段位称号（S10，幂等，best-effort）
  await grantTitleToPlayer(cols, accountId, titleId, now).catch((e) =>
    log.error('settleSeasonForPlayer: grantTitle failed', { accountId, prevSeasonNo, peakRank, err: (e as Error).message }),
  );

  if (totalCoins <= 0) {
    log.info('settleSeasonForPlayer: no coin reward', { accountId, prevSeasonNo, peakRank });
    return { peakRank, peakElo, coins: 0, titleId };
  }

  // 走邮件：异步发放，玩家登录后收到通知 + 仪式感
  const dispatchKey = `ladder.season.${prevSeasonNo}.${accountId}`;
  await insertSystemMail(
    cols,
    dispatchKey,
    accountId,
    {
      subject: `mail.season.settle.subject`,
      body: `mail.season.settle.body`,
      attachments: [{ kind: 'coins', count: totalCoins }],
      expireDays: SETTLE_MAIL_EXPIRE_DAYS,
    },
    now,
  );
  log.info('settleSeasonForPlayer: mail sent', {
    accountId,
    prevSeasonNo,
    peakRank,
    coins,
    bpCoins,
    totalCoins,
  });
  return { peakRank, peakElo, coins: totalCoins, titleId };
}

/** 单玩家赛季结算摘要（写快照 + 统计用）。 */
export interface SeasonSettleSummary {
  peakRank: RankId;
  peakElo: number;
  /** 实际发放金币（峰值 + 战令补发；0 = 仅授予称号无金币）。 */
  coins: number;
  titleId: string;
}

/**
 * 赛季收束闭环（L2-1）：对刚收束赛季 `seasonNo` 的所有参与者主动结算。
 * 与惰性迁移（migrateIfStale）共用 settleSeasonForPlayer，保证「主动批量」与「玩家回归再结算」
 * 两条路径完全幂等（结算邮件 dispatchKey + 称号 $addToSet + 快照 _id 三重去重，重复 close 同季不双发）。
 * 解决断裂链路：不再依赖玩家登录才发奖，季末一次性结清全部参与者。
 *
 * **不做软重置**：软重置/战令重置仍由玩家下次 pvp 读写时的 migrateIfStale 惰性执行（季末批量改全表写
 * 风险高且无必要——结算只读 + 写邮件/称号/快照，玩家档案的 elo 留待回归时迁移，幂等不会双发）。
 */
export async function settleSeasonParticipants(
  cols: Collections,
  commercial: CommercialClient,
  seasonNo: number,
  now: number,
): Promise<{ settled: number; rewarded: number }> {
  let settled = 0;
  let rewarded = 0;
  const cursor = cols.saves.find({ 'save.pvp.seasonNo': seasonNo });
  for await (const doc of cursor) {
    try {
      const summary = await settleSeasonForPlayer(cols, commercial, doc._id, doc.save, seasonNo, now);
      settled++;
      if (summary.coins > 0) rewarded++;
      // 快照兼幂等账本：_id 复合键，$setOnInsert 保证重复 close 同季不覆写已结算记录。
      await cols.ladderSeasonSnapshots.updateOne(
        { _id: `${seasonNo}:${doc._id}` },
        {
          $setOnInsert: {
            _id: `${seasonNo}:${doc._id}`,
            seasonNo,
            accountId: doc._id,
            peakElo: summary.peakElo,
            peakRank: summary.peakRank,
            coins: summary.coins,
            titleId: summary.titleId,
            ts: now,
          },
        },
        { upsert: true },
      );
    } catch (e) {
      log.error('settleSeasonParticipants: player settle failed', {
        accountId: doc._id,
        seasonNo,
        err: (e as Error).message,
      });
    }
  }
  log.info('settleSeasonParticipants done', { seasonNo, settled, rewarded });
  return { settled, rewarded };
}

// ── 惰性迁移（核心，每次 pvp 读写前调用）────────────────────────────────────

/**
 * 检查 save.pvp.seasonNo 是否落后于 currentSeason，若是则：
 * 1. 结算上赛季奖励（settleSeasonForPlayer）
 * 2. 软重置 ELO
 * 3. 推进 pvp.seasonNo
 * 4. 重置战令
 *
 * 返回「是否发生了迁移」和「更新后的 save」。
 * **调用方**负责把 next save 原子写库（乐观锁 rev 守卫）。
 */
export async function migrateIfStale(
  cols: Collections,
  commercial: CommercialClient,
  save: SaveData,
  currentSeason: LadderSeasonDoc,
  now: number,
): Promise<{ migrated: boolean; save: SaveData }> {
  const pvpSeasonNo = save.pvp.seasonNo ?? 1;
  if (pvpSeasonNo >= currentSeason.seasonNo) {
    return { migrated: false, save };
  }

  // 发放上赛季奖励（best-effort，失败不阻断迁移，下次重入幂等邮件键守卫）
  try {
    await settleSeasonForPlayer(cols, commercial, save.accountId, save, pvpSeasonNo, now);
  } catch (e) {
    log.error('settleSeasonForPlayer failed', {
      accountId: save.accountId,
      err: (e as Error).message,
    });
  }

  const newElo = softReset(save.pvp.elo, SEASON_RESET_BASELINE);
  const newRank = eloToRank(newElo) as RankId;
  const defaults = makePvpSeasonDefaults(currentSeason.seasonNo, newElo);

  // 重置战令（补发已在 settleSeasonForPlayer 处理）
  const newBp = makeFreshBattlePass(currentSeason.seasonNo);

  const next: SaveData = {
    ...save,
    pvp: {
      ...save.pvp,
      elo: newElo,
      rank: newRank,
      streak: 0,          // 连胜串跨季清零
      ...defaults,
    },
    battlePass: newBp,
  };

  log.info('pvp migrated', {
    accountId: save.accountId,
    from: pvpSeasonNo,
    to: currentSeason.seasonNo,
    eloFrom: save.pvp.elo,
    eloAfter: newElo,
  });
  return { migrated: true, save: next };
}
