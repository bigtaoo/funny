// meta 内部路由（M17/M19，S1-M3）——玩家不可见，X-Internal-Key 鉴权，不经 openapi glue。
//   GET  /internal/elo            gateway 入队前取 ELO（matchsvc 保持 DB-free，§8.5）
//   POST /internal/match/report   gameserver 局末上报：比对 + 算 ELO 写 saves.pvp + 归档 matches（§8.3）
//
// ELO 结算 / 归档逻辑从 gameserver 迁来（M19）：天梯权威收归 meta。room_id 幂等（matches 唯一）。
import type { FastifyInstance } from 'fastify';
import type { Collections, SaveDoc, SaveData } from '@nw/shared';
import {
  INITIAL_ELO,
  ELO_FLOOR,
  computeEloDelta,
  eloToRank,
  nextStreak,
  victoryCoinsForRank,
  createLogger,
  createInternalAuth,
  sanitizePvpReportedStats,
  accrueStats,
  computeFirstReachGrant,
  BP_XP_PER_RANKED_WIN,
  BP_XP_PER_RANKED_LOSS,
  xpToLevel,
  type StatKey,
  type RankId,
} from '@nw/shared';
import {
  getCurrentSeason,
  migrateIfStale,
  rollSeason,
} from './ladderSeason.js';
import { writeMigratedSave } from './save.js';
import type { GatewayClient } from './gatewayClient.js';
import type { CommercialClient } from './commercialClient.js';
import { adsDayKey } from './economy.js';
import { getProfile, resolveByPublicId } from './accounts.js';
import { grantTitleToPlayer } from './titles.js';
import { friendAccountIds } from './social.js';
import { insertSystemMail, bulkInsertSystemMail } from './mail.js';
import { escrowEquipment, grantEquipment } from './equipment.js';
import type { CompTarget, EquipmentInstance, MailAttachmentDoc } from '@nw/shared';
import { ERROR_HTTP_STATUS } from '@nw/shared';

const log = createLogger('meta:internal');

/** 内嵌录像帧字节上限；超过则外置 replayBlobs + replayRef（保持 matches 文档精简）。 */
const REPLAY_INLINE_MAX_BYTES = 256 * 1024;

/** 全服系统邮件 fan-out 每批账号数（一次 bulkWrite 的 op 数）。MongoDB 单批上限 1000，留余量。 */
const MAIL_FANOUT_BATCH = 500;

interface EloResult {
  delta: number;
  after: number;
  rankAfter: string;
}

interface ReportBody {
  room_id: string;
  seed: string;
  mode: string; // friendly | ranked
  reason: string; // base | disconnect | mismatch
  winner_side: number;
  hash_ok: boolean;
  players: { side: number; accountId: string }[];
  results: { side: number; state_hash: string; winner_side: number; stats?: Record<string, number> }[];
  replay: {
    engineVersion: number;
    mode: string;
    seed: string;
    endFrame: number;
    frames: { frame: number; cmds: { side: number; commands: string }[] }[];
    meta: { recordedAt: number; winner: number };
  };
}

export interface InternalDeps {
  cols: Collections;
  /** 单一共享密钥（legacy 回退 + ticket HMAC 用）。 */
  internalKey: string;
  /** 可选 per-caller 密钥注册表（NW_INTERNAL_KEYS 解析）；非空则启用严格 per-caller 鉴权。 */
  internalKeys?: Record<string, string>;
  now: () => number;
  /** 对等裁判客户端（Phase C）。未配置则 available=false，ranked 不一致直接作废。 */
  gateway: GatewayClient;
  /** commercial 客户端：ranked 胜者发分段胜利金币（§2.3b）。未配置则不发。 */
  commercial: CommercialClient;
}

export function registerInternalRoutes(app: FastifyInstance, deps: InternalDeps): void {
  const { cols, internalKey, internalKeys, now, gateway, commercial } = deps;

  // 集中校验器：timing-safe + per-caller 严格（NW_INTERNAL_KEYS）+ 单一共享密钥回退。
  const auth = createInternalAuth({ keys: internalKeys, legacyKey: internalKey });
  const authed = (key: unknown): boolean =>
    auth.verify({ 'x-internal-key': typeof key === 'string' ? key : undefined }).ok;

  // ── GET /internal/elo?accountId= ──────────────────────────────────────
  app.get('/internal/elo', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const accountId = (req.query as { accountId?: string }).accountId;
    if (!accountId) return reply.code(400).send({ ok: false, error: 'accountId required' });
    const doc = await cols.saves.findOne({ _id: accountId });
    const elo = doc?.save.pvp.elo ?? INITIAL_ELO;
    log.info('GET /internal/elo', { accountId, elo, hasSave: !!doc });
    return reply.send({ elo });
  });

  // ── GET /internal/profile?accountId= ──────────────────────────────────
  // gateway 据此把房间玩家显示为昵称（#publicId），而非 accountId。publicId 惰性生成。
  app.get('/internal/profile', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const accountId = (req.query as { accountId?: string }).accountId;
    if (!accountId) return reply.code(400).send({ ok: false, error: 'accountId required' });
    const profile = await getProfile(cols, accountId);
    return reply.send(profile); // { displayName?, publicId }
  });

  // ── GET /internal/player?publicId= ───────────────────────────────────
  // admin 后台玩家查询（OPS_DESIGN §4.1 player.lookup）：按 9 位公开 id 反查档案摘要。
  app.get('/internal/player', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const publicId = (req.query as { publicId?: string }).publicId;
    if (!publicId) return reply.code(400).send({ ok: false, error: 'publicId required' });
    const accountId = await resolveByPublicId(cols, publicId);
    if (!accountId) return reply.code(404).send({ ok: false, error: 'not found' });
    const [profile, saveDoc] = await Promise.all([
      getProfile(cols, accountId),
      cols.saves.findOne({ _id: accountId }),
    ]);
    const pvp = saveDoc?.save.pvp;
    return reply.send({
      publicId,
      accountId,
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(pvp
        ? { rank: pvp.rank, elo: pvp.elo, wins: pvp.wins, losses: pvp.losses }
        : {}),
    });
  });

  // ── GET /internal/anticheat/reviews?accountId=&status=&limit= ────────
  // admin 后台反作弊审查队列（S9-7，ACHIEVEMENT_DESIGN §4.4）：列离线抽查实锤的超报记录。
  // 默认 status=open；可按 accountId 过滤；limit 1..100。
  app.get('/internal/anticheat/reviews', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const q = req.query as { accountId?: string; status?: string; limit?: string };
    const filter: Record<string, unknown> = {};
    if (q.accountId) filter.accountId = q.accountId;
    if (q.status === 'open' || q.status === 'reviewed') filter.status = q.status;
    else if (q.status === undefined) filter.status = 'open';
    // status=all（或其它）→ 不限状态
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
    const reviews = await cols.antiCheatReviews
      .find(filter)
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    return reply.send({ reviews });
  });

  // ── GET /internal/social/friends?accountId= ──────────────────────────
  // gateway 据此算 presence 广播范围（连/断时向该用户的在线好友 push friend_presence）。
  app.get('/internal/social/friends', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const accountId = (req.query as { accountId?: string }).accountId;
    if (!accountId) return reply.code(400).send({ ok: false, error: 'accountId required' });
    const friends = await friendAccountIds(cols, accountId);
    return reply.send({ friends });
  });

  // ── 系统邮件（S6-3，OPS_DESIGN §3.3）：admin 补偿工单经 HttpMailDispatcher 调用。──
  // 钱在玩家领邮件时才经 commercial/inventory 入账（admin 从不直接写钱包）。dispatchKey 幂等。
  interface SystemMailBody {
    dispatchKey: string;
    scope?: 'single' | 'global';
    /** 内部直投 accountId（§17.5，worldsvc 等无 publicId 的内部调用方）；与 target 二选一。 */
    accountId?: string;
    target?: CompTarget;
    subject: string;
    body: string;
    // MailAttachmentDoc（非 CompAttachment）：除 OPS 补偿的 coins/item/skin，还含 worldsvc 赛季奖励的
    // 'material'（→ SaveData.materials 养成统一池，SLG8）。CompAttachment 是其子集。
    attachments: MailAttachmentDoc[];
    expireDays: number;
  }

  // POST /internal/mail/system/preview → { ok, recipientCount }
  app.post('/internal/mail/system/preview', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const b = req.body as Pick<SystemMailBody, 'scope' | 'target'>;
    if (b.scope === 'global') {
      const recipientCount = await cols.accounts.countDocuments({});
      return reply.send({ ok: true, recipientCount });
    }
    const publicId = b.target && 'publicId' in b.target ? b.target.publicId : '';
    const accountId = await resolveByPublicId(cols, publicId);
    return reply.send({ ok: true, recipientCount: accountId ? 1 : 0 });
  });

  // POST /internal/mail/system/send → { ok, recipientCount }
  app.post('/internal/mail/system/send', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const b = req.body as SystemMailBody;
    if (!b?.dispatchKey || !b.subject) {
      return reply.code(400).send({ ok: false, error: 'dispatchKey + subject required' });
    }
    const content = {
      subject: b.subject,
      body: b.body ?? '',
      attachments: b.attachments ?? [],
      expireDays: b.expireDays ?? 0,
    };

    if (b.scope === 'global') {
      // 全服 fan-out 分批：每批 MAIL_FANOUT_BATCH 个账号走一次 bulkWrite（unordered upsert），
      // O(N) 次往返压成 O(N/批)。仅本批新插入的收件人推红点（dispatchKey 幂等，重试不重复推）。
      let recipientCount = 0;
      let insertedCount = 0;
      let batch: string[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const ids = batch;
        batch = [];
        const r = await bulkInsertSystemMail(cols, b.dispatchKey, ids, content, now());
        recipientCount += ids.length;
        insertedCount += r.insertedAccountIds.length;
        for (const accountId of r.insertedAccountIds) {
          // 离线 gateway 自行丢弃；push fire-and-forget 不阻塞批次。
          void gateway.push(accountId, {
            kind: 'mail_new',
            mailId: `${b.dispatchKey}:${accountId}`,
            hasAttachment: r.hasAttachment,
          });
        }
      };
      const cursor = cols.accounts.find({}, { projection: { _id: 1 } });
      for await (const doc of cursor) {
        batch.push(doc._id);
        if (batch.length >= MAIL_FANOUT_BATCH) await flush();
      }
      await flush();
      log.info('POST /internal/mail/system/send (global)', {
        dispatchKey: b.dispatchKey,
        recipientCount,
        insertedCount,
      });
      return reply.send({ ok: true, recipientCount });
    }

    // 内部直投分支（§17.5）：worldsvc 等内部调用方按 accountId 直投（无 publicId），跳过解析。
    const directAccountId =
      typeof (b as { accountId?: unknown }).accountId === 'string'
        ? (b as { accountId: string }).accountId
        : null;
    const publicId = b.target && 'publicId' in b.target ? b.target.publicId : '';
    const accountId = directAccountId ?? (await resolveByPublicId(cols, publicId));
    if (!accountId) return reply.send({ ok: false, recipientCount: 0, error: 'recipient not found' });
    const r = await insertSystemMail(cols, b.dispatchKey, accountId, content, now());
    if (r.inserted) {
      void gateway.push(accountId, { kind: 'mail_new', mailId: r.mailId, hasAttachment: r.hasAttachment });
    }
    log.info('POST /internal/mail/system/send (single)', { dispatchKey: b.dispatchKey, publicId });
    return reply.send({ ok: true, recipientCount: 1 });
  });

  // ── POST /internal/match/report ───────────────────────────────────────
  app.post('/internal/match/report', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const body = req.body as ReportBody;
    if (!body?.room_id) return reply.code(400).send({ ok: false, error: 'room_id required' });
    log.info('POST /internal/match/report', {
      roomId: body.room_id,
      mode: body.mode,
      reason: body.reason,
      winner: body.winner_side,
      hashOk: body.hash_ok,
    });

    // 幂等：同 room_id 已归档则直接 ok（重发不重复结算）。
    const existing = await cols.matches.findOne({ roomId: body.room_id });
    if (existing) return reply.send({ ok: true });

    // ranked + 有胜方 + 未作废（base/disconnect）→ 服务器权威结算 ELO。
    const settleRanked =
      body.mode === 'ranked' && body.winner_side >= 0 && body.reason !== 'mismatch';
    let eloBySide: Record<number, EloResult> | null = null;
    let cheat: { side: number; accountId: string; judgeAccountId?: string } | undefined;
    // S9-7：归档已入账的 per-side 上报值作离线抽查比对基准（仅 ranked 正常结算；mismatch 局不喂故为空）。
    let reportedStats: Record<string, Partial<Record<StatKey, number>>> | undefined;
    if (settleRanked) {
      const winner = body.players.find((p) => p.side === body.winner_side);
      const loser = body.players.find((p) => p.side !== body.winner_side);
      if (winner && loser) {
        // S9-6: 清洗各方上报的本局成就计数（L1 异常复查，§4.4）。越界/非法 → null 拒收该方 kill/cast
        // （pvp.wins/ELO 仍照常）；嫌疑升档（statSuspicion）属 S9-7（离线抽查 anticheatAudit.ts）。
        const wStats = statDeltaForSide(body, winner.side);
        const lStats = statDeltaForSide(body, loser.side);
        reportedStats = { [String(winner.side)]: wStats, [String(loser.side)]: lStats };
        try {
          eloBySide = await settleElo(cols, now, commercial, winner, loser, wStats, lStats);
        } catch (e) {
          log.error('ranked ELO settle failed', { err: (e as Error).message });
        }
      }
    } else if (body.mode === 'ranked' && body.reason === 'mismatch' && gateway.available) {
      // Phase C 对等裁判：两端 hash 不一致 → 挑第三方无头复算定罪（而非直接作废）。
      try {
        const verdict = await judgeMismatch(gateway, body);
        if (verdict) {
          // hash 不一致的局已是嫌疑局：不累加任一方自报 kill/cast（pvp.wins 仍随诚实方胜场计）。
          eloBySide = await settleElo(cols, now, commercial, verdict.honest, verdict.cheater, {}, {});
          cheat = {
            side: verdict.cheater.side,
            accountId: verdict.cheater.accountId,
            ...(verdict.judgeAccountId ? { judgeAccountId: verdict.judgeAccountId } : {}),
          };
        }
      } catch (e) {
        log.error('peer judge failed', { err: (e as Error).message });
      }
    }

    // 归档前 enrich 每方身份快照（昵称 / publicId）+ ELO 结算结果（仅 ranked）。
    // 快照在归档当刻定格，事后改名不回填——战绩历史按当时显示。
    const enrichedPlayers = await Promise.all(
      body.players.map(async (p) => {
        const profile = await getProfile(cols, p.accountId).catch(() => ({ publicId: undefined as string | undefined }));
        const elo = eloBySide?.[p.side];
        return {
          side: p.side,
          accountId: p.accountId,
          ...((profile as { displayName?: string }).displayName
            ? { displayName: (profile as { displayName?: string }).displayName }
            : {}),
          ...(profile.publicId ? { publicId: profile.publicId } : {}),
          ...(elo ? { eloDelta: elo.delta, eloAfter: elo.after } : {}),
        };
      }),
    );

    // 归档 matches。winner -1 = 未知（friendly 正常结束）。
    // 录像：小局内嵌 `replay`；超阈值的大局外置 `replayBlobs` + `replayRef`（matches 文档保持精简）。
    const replayDoc = {
      engineVersion: body.replay.engineVersion,
      mode: body.replay.mode,
      seed: body.replay.seed,
      endFrame: body.replay.endFrame,
      frames: body.replay.frames, // cmds[].commands 为 base64 opaque（不解码 M12）
      meta: body.replay.meta,
    };
    const replayBytes = JSON.stringify(replayDoc.frames).length;
    const inline = replayBytes <= REPLAY_INLINE_MAX_BYTES;
    if (!inline) {
      // 先写 blob（roomId 幂等覆盖），matches 仅留 replayRef 指针。
      await cols.replayBlobs
        .updateOne(
          { _id: body.room_id },
          { $set: { _id: body.room_id, replay: replayDoc, ts: now() } },
          { upsert: true },
        )
        .catch((e) => log.error('archive replay blob failed', { err: (e as Error).message }));
    }
    await cols.matches
      .insertOne({
        roomId: body.room_id,
        mode: body.mode,
        seed: body.seed,
        players: enrichedPlayers,
        winner: cheat ? body.players.find((p) => p.side !== cheat!.side)!.side : body.winner_side,
        reason: body.reason,
        hashOk: body.hash_ok,
        // C3：hash 不一致且对等裁判未介入（无 cheat 定罪）→ 标记供 admin 审查。
        ...(!body.hash_ok && !cheat ? { hashMismatch: true } : {}),
        ...(inline ? { replay: replayDoc } : { replayRef: body.room_id }),
        ...(cheat ? { cheat } : {}),
        ...(reportedStats ? { reportedStats } : {}),
        ts: now(),
      })
      .catch((e) => {
        // 幂等竞态：唯一索引冲突说明并发已归档，忽略。
        if ((e as { code?: number }).code !== 11000) log.error('archive match failed', { err: (e as Error).message });
      });

    // C3：hash 不一致且未经对等裁判 → 告警日志（admin /admin/mismatches 可见）。
    if (!body.hash_ok && !cheat) {
      log.warn('hash mismatch unresolved', {
        roomId: body.room_id,
        mode: body.mode,
        accountIds: body.players.map((p) => p.accountId),
      });
    }

    return reply.send({ ok: true, ...(eloBySide ? { elo: eloBySide } : {}) });
  });

  // ── GET /internal/mismatches（C3）─────────────────────────────────────────
  // 返回 24h 内 hashMismatch=true 的对局列表（admin 调用）。
  app.get('/internal/mismatches', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const since = now() - 24 * 3600 * 1000;
    const matches = await cols.matches
      .find({ hashMismatch: true, ts: { $gte: since } })
      .sort({ ts: -1 })
      .limit(200)
      .project({ roomId: 1, mode: 1, players: 1, reason: 1, ts: 1 })
      .toArray();
    return reply.send({ ok: true, matches });
  });

  // ── GET /internal/suspicious-pve（C4）─────────────────────────────────────────
  // 返回 pveWarnings > 0 的账号列表（admin 人工审核用）。
  app.get('/internal/suspicious-pve', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const accounts = await cols.accounts
      .find({ 'flags.pveWarnings': { $gt: 0 } })
      .sort({ 'flags.pveWarnings': -1 })
      .limit(200)
      .project({ _id: 1, displayName: 1, publicId: 1, 'flags.pveWarnings': 1, 'flags.banned': 1, createdAt: 1 })
      .toArray();
    return reply.send({ ok: true, accounts });
  });

  // ── 材料扣除 / 发放（S8-5，worldsvc 拍卖场调用）─────────────────────────────────
  // 不经 openapi glue，X-Internal-Key 鉴权。
  // POST /internal/materials/deduct  { accountId, material, qty, orderId }
  //   → 扣除指定材料；不足 → 402；乐观锁冲突重试 3 次后 409。
  app.post('/internal/materials/deduct', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, material, qty } = req.body as {
      accountId?: string;
      material?: string;
      qty?: number;
    };
    if (!accountId || !material || typeof qty !== 'number' || qty <= 0) {
      return reply.code(400).send({ ok: false, error: 'accountId + material + qty (>0) required' });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) return reply.code(404).send({ ok: false, error: 'save not found' });
      const cur = doc.save.materials?.[material] ?? 0;
      if (cur < qty) return reply.code(402).send({ ok: false, error: 'insufficient materials' });
      const next: SaveData = {
        ...doc.save,
        rev: doc.save.rev + 1,
        updatedAt: now(),
        materials: { ...doc.save.materials, [material]: cur - qty },
      };
      const res = await cols.saves.findOneAndUpdate(
        { _id: accountId, rev: doc.rev },
        { $set: { save: next, rev: next.rev } },
      );
      if (res) return reply.send({ ok: true, remaining: cur - qty });
    }
    return reply.code(409).send({ ok: false, error: 'rev conflict, retry' });
  });

  // POST /internal/materials/grant  { accountId, material, qty, orderId }
  //   → 发放指定材料；幂等（orderId 目前仅日志，无 dedup 集合，best-effort）。
  app.post('/internal/materials/grant', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, material, qty, orderId } = req.body as {
      accountId?: string;
      material?: string;
      qty?: number;
      orderId?: string;
    };
    if (!accountId || !material || typeof qty !== 'number' || qty <= 0) {
      return reply.code(400).send({ ok: false, error: 'accountId + material + qty (>0) required' });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) return reply.code(404).send({ ok: false, error: 'save not found' });
      const cur = doc.save.materials?.[material] ?? 0;
      const next: SaveData = {
        ...doc.save,
        rev: doc.save.rev + 1,
        updatedAt: now(),
        materials: { ...doc.save.materials, [material]: cur + qty },
      };
      const res = await cols.saves.findOneAndUpdate(
        { _id: accountId, rev: doc.rev },
        { $set: { save: next, rev: next.rev } },
      );
      if (res) {
        log.info('materials granted', { accountId, material, qty, orderId, after: cur + qty });
        return reply.send({ ok: true, after: cur + qty });
      }
    }
    return reply.code(409).send({ ok: false, error: 'rev conflict, retry' });
  });

  // ── 装备托管 / 转移（E2，worldsvc 拍卖装备交易调用）─────────────────────────────
  // POST /internal/equipment/escrow  { accountId, instanceId, orderId } → { instance }
  //   挂拍托管：校验未穿戴/未锁 → 移出卖方库存 → 回快照（worldsvc 存进挂单 doc）。orderId 幂等。
  app.post('/internal/equipment/escrow', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, instanceId, orderId } = req.body as {
      accountId?: string;
      instanceId?: string;
      orderId?: string;
    };
    if (!accountId || !instanceId || !orderId) {
      return reply.code(400).send({ ok: false, error: 'accountId + instanceId + orderId required' });
    }
    const r = await escrowEquipment(cols, now, accountId, instanceId, orderId);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    log.info('equipment escrowed', { accountId, instanceId, orderId });
    return reply.send({ ok: true, instance: r.instance });
  });

  // POST /internal/equipment/grant  { accountId, instance, orderId } → { ok }
  //   成交转移（给买方）/ 撤单·过期·季末退回（给卖方）：把实例快照写入库存（按 id 覆盖即幂等）。
  app.post('/internal/equipment/grant', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const { accountId, instance, orderId } = req.body as {
      accountId?: string;
      instance?: EquipmentInstance;
      orderId?: string;
    };
    if (!accountId || !instance?.id) {
      return reply.code(400).send({ ok: false, error: 'accountId + instance required' });
    }
    const r = await grantEquipment(cols, now, accountId, instance);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send({ ok: false, error: r.error, code: r.code });
    log.info('equipment granted', { accountId, instanceId: instance.id, orderId });
    return reply.send({ ok: true });
  });

  // ── 养成快照（E8，worldsvc 围攻引擎权威计算调用）────────────────────────────────
  // GET /internal/save-fields?accountId=  → { pveUpgrades, unitLevels, gear, equipmentInv }
  //   返回攻方养成相关字段，供 worldsvc 传入 buildSiegeBlueprints 计算权威蓝图。
  //   账号不存在视为新账号（返回空默认），不返回 404，避免冻结行军。
  app.get('/internal/save-fields', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const accountId = (req.query as Record<string, string>).accountId;
    if (!accountId) return reply.code(400).send({ ok: false, error: 'accountId required' });
    const doc = await cols.saves.findOne({ _id: accountId });
    const s = doc?.save;
    return reply.send({
      pveUpgrades: s?.pveUpgrades ?? {},
      unitLevels: s?.unitLevels ?? {},
      gear: s?.gear ?? {},
      equipmentInv: s?.equipmentInv ?? {},
    });
  });

  // ── POST /admin/ladder/season/roll ────────────────────────────────────────
  // admin（ops 后台）手动开启新赛季（S11-SE-3，SEASON_DESIGN §3.1）。
  // CAS 幂等：并发/误点重入返回当前赛季，不重复推进。
  app.post('/admin/ladder/season/roll', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    try {
      const season = await rollSeason(cols, now());
      log.info('POST /admin/ladder/season/roll', { seasonNo: season.seasonNo });
      return reply.send({ ok: true, season });
    } catch (e) {
      log.error('rollSeason failed', { err: (e as Error).message });
      return reply.code(500).send({ ok: false, error: 'roll failed' });
    }
  });

  // ── POST /admin/grant-title ───────────────────────────────────────────────────────
  // admin 手动授予称号（S10，TITLE_DESIGN §8 admin 授予）。幂等：已拥有则 no-op。
  app.post('/admin/grant-title', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const { accountId, titleId } = req.body as { accountId?: string; titleId?: string };
    if (!accountId || !titleId) {
      return reply.code(400).send({ ok: false, error: 'accountId and titleId required' });
    }
    try {
      await grantTitleToPlayer(cols, accountId, titleId, now());
      log.info('POST /admin/grant-title', { accountId, titleId });
      return reply.send({ ok: true });
    } catch (e) {
      log.error('grant-title failed', { accountId, titleId, err: (e as Error).message });
      return reply.code(500).send({ ok: false, error: 'grant failed' });
    }
  });

  // ── GET /internal/leaderboard ─────────────────────────────────────────────────────
  // 全服 Top100（S11-SE-5，SEASON_DESIGN §5）。X-Internal-Key 鉴权，供 admin 查询；玩家侧见 service.ts getLeaderboard。
  app.get('/internal/leaderboard', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const season = await getCurrentSeason(cols, now());
    const top = await cols.saves
      .find({ 'save.pvp.seasonNo': season.seasonNo })
      .sort({ 'save.pvp.elo': -1 })
      .limit(100)
      .project({ _id: 1, 'save.pvp': 1, 'save.equipped': 1 })
      .toArray();
    const accounts = await Promise.all(
      top.map((d) => cols.accounts.findOne({ _id: d._id }, { projection: { displayName: 1, publicId: 1 } })),
    );
    const entries = top.map((d, i) => ({
      rank: i + 1,
      accountId: d._id,
      displayName: accounts[i]?.displayName,
      publicId: accounts[i]?.publicId,
      elo: (d as unknown as { save: { pvp: { elo: number; rank: string } } }).save.pvp.elo,
      rankId: (d as unknown as { save: { pvp: { rank: string } } }).save.pvp.rank,
    }));
    return reply.send({ season, top: entries });
  });
}

/**
 * 对等裁判（Phase C）：把整局录像发给 gateway 挑第三方无头复算，按裁判 hash 判定哪方诚实。
 * 返回 {诚实方, 作弊方, 裁判 accountId}；裁判不可裁（无候选/超时/复算失败/结果对不上任一方）→ null。
 */
async function judgeMismatch(
  gateway: GatewayClient,
  body: ReportBody,
): Promise<{
  honest: { side: number; accountId: string };
  cheater: { side: number; accountId: string };
  judgeAccountId?: string;
} | null> {
  if (body.results.length !== 2) return null;
  const verdict = await gateway.judge({
    seed: Number(body.seed),
    mode: 1, // RANKED（裁判客户端按 netplay 复算，mode 仅审计语义）
    endFrame: body.replay.endFrame,
    frames: body.replay.frames, // command bytes 已是 base64，原样转交
    exclude: body.players.map((p) => p.accountId),
  });
  if (!verdict.ok || !verdict.stateHash) return null;

  // 裁判 hash 命中哪方 → 那方诚实；另一方（hash 不符）作弊。两端 hash 互不相同，
  // 故至多一方命中；若都不命中（裁判结果对不上任何一方）则无法定罪 → 作废。
  const honestRes = body.results.find((r) => r.state_hash === verdict.stateHash);
  const cheaterRes = body.results.find((r) => r.state_hash !== verdict.stateHash);
  if (!honestRes || !cheaterRes) return null;
  const honest = body.players.find((p) => p.side === honestRes.side);
  const cheater = body.players.find((p) => p.side === cheaterRes.side);
  if (!honest || !cheater) return null;
  return {
    honest,
    cheater,
    ...(verdict.judgeAccountId ? { judgeAccountId: verdict.judgeAccountId } : {}),
  };
}

/**
 * S9-6: 取某方上报的本局成就计数并经 L1 清洗（§4.4）。
 * 返回 sanitize 后的 statKey 增量；越界/非法 → 记日志后返回 `{}`（拒收该方 kill/cast，pvp.wins 仍照常）。
 */
function statDeltaForSide(body: ReportBody, side: number): Partial<Record<StatKey, number>> {
  const reported = body.results.find((r) => r.side === side)?.stats;
  const clean = sanitizePvpReportedStats(reported);
  if (clean === null) {
    log.warn('PvP stat L1 reject (out-of-bounds reported stats)', { roomId: body.room_id, side });
    return {};
  }
  return clean;
}

/** 双方 ELO 结算：读分 → 算分差 → 各自原子写 saves.pvp（乐观锁 rev 守卫 + 重试）。 */
async function settleElo(
  cols: Collections,
  now: () => number,
  commercial: CommercialClient,
  winner: { side: number; accountId: string },
  loser: { side: number; accountId: string },
  // S9-6: 已 L1 清洗的本局 kill/cast 增量（仅 ranked 喂）。pvp.wins 由 won 在 applyPvp 内自算。
  winnerStats: Partial<Record<StatKey, number>> = {},
  loserStats: Partial<Record<StatKey, number>> = {},
): Promise<Record<number, EloResult>> {
  const [wDoc, lDoc] = await Promise.all([
    cols.saves.findOne({ _id: winner.accountId }),
    cols.saves.findOne({ _id: loser.accountId }),
  ]);
  const wElo = wDoc?.save.pvp.elo ?? INITIAL_ELO;
  const lElo = lDoc?.save.pvp.elo ?? INITIAL_ELO;
  const { winner: wDelta, loser: lDelta } = computeEloDelta(wElo, lElo);
  const out: Record<number, EloResult> = {};
  const [wRes, lRes] = await Promise.all([
    applyPvp(cols, now, commercial, winner.accountId, wDoc, wDelta, true, winnerStats),
    applyPvp(cols, now, commercial, loser.accountId, lDoc, lDelta, false, loserStats),
  ]);
  if (wRes) out[winner.side] = wRes;
  if (lRes) out[loser.side] = lRes;

  // 分段胜利金币（§2.3b）：仅胜者，按结算后段位发，commercial 权威 enforce 每日上限。
  // best-effort——发币失败不影响 ELO 结算（钱包是 commercial 权威，下次 GET /save 对账）。
  if (wRes && commercial.available) {
    const amount = victoryCoinsForRank(wRes.rankAfter);
    try {
      await commercial.victoryCredit({
        accountId: winner.accountId,
        amount,
        dayKey: adsDayKey(now()),
      });
    } catch (e) {
      log.error('victory coin credit failed', {
        accountId: winner.accountId,
        err: (e as Error).message,
      });
    }
  }
  return out;
}

/** 单方 pvp 原子更新（整体替换 save，同 putSave 约定，避免与客户端 PUT /save 并发互覆盖）。 */
async function applyPvp(
  cols: Collections,
  now: () => number,
  commercial: CommercialClient,
  accountId: string,
  doc: SaveDoc | null,
  delta: number,
  won: boolean,
  statDelta: Partial<Record<StatKey, number>> = {},
): Promise<EloResult | null> {
  // S9-6: 本局成就计数增量 = L1 清洗后的 kill/cast + 服务器自算的 pvp.wins（仅胜方 +1，不信客户端）。
  const fullStatDelta: Partial<Record<StatKey, number>> = { ...statDelta, ...(won ? { 'pvp.wins': 1 } : {}) };
  // S11：ranked 结算前先过惰性迁移（季末才触发，通常 no-op）。
  const currentSeason = await getCurrentSeason(cols, now()).catch(() => null);
  for (let attempt = 0; attempt < 3; attempt++) {
    let cur = attempt === 0 && doc ? doc : await cols.saves.findOne({ _id: accountId });
    if (!cur) return null; // ranked 玩家应已有存档
    // 惰性迁移：若落后赛季则先结算上季并软重置（极少触发，通常 no-op）。
    if (currentSeason) {
      const mr = await migrateIfStale(cols, commercial, cur.save, currentSeason, now());
      if (mr.migrated) {
        // 迁移产出的 save 需先落库，再做 ELO 更新；否则迁移结果丢失。
        const migrated = await writeMigratedSave(
          cols,
          mr.save,
          now(),
          (s) => migrateIfStale(cols, commercial, s, currentSeason, now()),
        );
        cur = { _id: cur._id, save: migrated, rev: migrated.rev };
      }
    }
    const pvp = cur.save.pvp;
    const after = Math.max(ELO_FLOOR, pvp.elo + delta);
    const appliedDelta = after - pvp.elo;
    const rank = eloToRank(after) as RankId;

    // S11：段位首达金币 + 峰值追踪（§4.3）
    const reachedRanks: RankId[] = pvp.reachedRanks ?? [];
    const { coins: firstReachAmt, newly } = computeFirstReachGrant(rank, reachedRanks);

    const nextStats = accrueStats(cur.save.stats, fullStatDelta); // 懒创建：无增量则原样保留
    const newPeakElo = Math.max(pvp.seasonPeakElo ?? after, after);
    const newPeakRank = eloToRank(newPeakElo) as RankId;
    // S11：每局 ranked 给予赛季经验（战令进度，§C）。
    const bpXpGain = won ? BP_XP_PER_RANKED_WIN : BP_XP_PER_RANKED_LOSS;
    const prevBp = cur.save.battlePass;
    const newBp = prevBp ? { ...prevBp, xp: prevBp.xp + bpXpGain, level: xpToLevel(prevBp.xp + bpXpGain) } : null;
    const next: SaveData = {
      ...cur.save,
      rev: cur.save.rev + 1,
      updatedAt: now(),
      ...(nextStats ? { stats: nextStats } : {}),
      ...(newBp ? { battlePass: newBp } : {}),
      pvp: {
        ...pvp,
        elo: after,
        rank,
        streak: nextStreak(pvp.streak, won),
        wins: pvp.wins + (won ? 1 : 0),
        losses: pvp.losses + (won ? 0 : 1),
        seasonNo: pvp.seasonNo ?? (currentSeason?.seasonNo ?? 1),
        seasonPeakElo: newPeakElo,
        seasonPeakRank: newPeakRank,
        reachedRanks: newly.length > 0 ? [...reachedRanks, ...newly] : reachedRanks,
      },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: cur.save.rev },
      { $set: { save: next, rev: next.rev } },
      { returnDocument: 'after' },
    );
    if (res) {
      // 首达金币：玩家在场，直接记账（同成就/称号路径，即时反馈）。
      if (firstReachAmt > 0 && commercial.available) {
        try {
          await commercial.grant({
            accountId,
            amount: firstReachAmt,
            reason: 'rank_first_reach',
            orderId: `rank.first.${accountId}.${newly.join('.')}`,
          });
        } catch (e) {
          log.error('firstReach coin grant failed', { accountId, err: (e as Error).message });
        }
      }
      return { delta: appliedDelta, after, rankAfter: rank };
    }
    // rev 冲突（客户端并发 PUT /save）→ 重读重试
  }
  return null;
}
