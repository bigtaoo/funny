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
} from '@nw/shared';
import type { GatewayClient } from './gatewayClient.js';
import type { CommercialClient } from './commercialClient.js';
import { adsDayKey } from './economy.js';
import { getProfile, resolveByPublicId } from './accounts.js';
import { friendAccountIds } from './social.js';
import { insertSystemMail, bulkInsertSystemMail } from './mail.js';
import type { CompAttachment, CompTarget } from '@nw/shared';

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
  results: { side: number; state_hash: string; winner_side: number }[];
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
  internalKey: string;
  now: () => number;
  /** 对等裁判客户端（Phase C）。未配置则 available=false，ranked 不一致直接作废。 */
  gateway: GatewayClient;
  /** commercial 客户端：ranked 胜者发分段胜利金币（§2.3b）。未配置则不发。 */
  commercial: CommercialClient;
}

export function registerInternalRoutes(app: FastifyInstance, deps: InternalDeps): void {
  const { cols, internalKey, now, gateway, commercial } = deps;

  const authed = (key: unknown): boolean => key === internalKey;

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
    scope: 'single' | 'global';
    target: CompTarget;
    subject: string;
    body: string;
    attachments: CompAttachment[];
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
    const publicId = 'publicId' in b.target ? b.target.publicId : '';
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

    const publicId = 'publicId' in b.target ? b.target.publicId : '';
    const accountId = await resolveByPublicId(cols, publicId);
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
    if (settleRanked) {
      const winner = body.players.find((p) => p.side === body.winner_side);
      const loser = body.players.find((p) => p.side !== body.winner_side);
      if (winner && loser) {
        try {
          eloBySide = await settleElo(cols, now, commercial, winner, loser);
        } catch (e) {
          log.error('ranked ELO settle failed', { err: (e as Error).message });
        }
      }
    } else if (body.mode === 'ranked' && body.reason === 'mismatch' && gateway.available) {
      // Phase C 对等裁判：两端 hash 不一致 → 挑第三方无头复算定罪（而非直接作废）。
      try {
        const verdict = await judgeMismatch(gateway, body);
        if (verdict) {
          eloBySide = await settleElo(cols, now, commercial, verdict.honest, verdict.cheater);
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
        ...(inline ? { replay: replayDoc } : { replayRef: body.room_id }),
        ...(cheat ? { cheat } : {}),
        ts: now(),
      })
      .catch((e) => {
        // 幂等竞态：唯一索引冲突说明并发已归档，忽略。
        if ((e as { code?: number }).code !== 11000) log.error('archive match failed', { err: (e as Error).message });
      });

    return reply.send({ ok: true, ...(eloBySide ? { elo: eloBySide } : {}) });
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

/** 双方 ELO 结算：读分 → 算分差 → 各自原子写 saves.pvp（乐观锁 rev 守卫 + 重试）。 */
async function settleElo(
  cols: Collections,
  now: () => number,
  commercial: CommercialClient,
  winner: { side: number; accountId: string },
  loser: { side: number; accountId: string },
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
    applyPvp(cols, now, winner.accountId, wDoc, wDelta, true),
    applyPvp(cols, now, loser.accountId, lDoc, lDelta, false),
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
  accountId: string,
  doc: SaveDoc | null,
  delta: number,
  won: boolean,
): Promise<EloResult | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = attempt === 0 && doc ? doc : await cols.saves.findOne({ _id: accountId });
    if (!cur) return null; // ranked 玩家应已有存档
    const pvp = cur.save.pvp;
    const after = Math.max(ELO_FLOOR, pvp.elo + delta);
    const appliedDelta = after - pvp.elo;
    const rank = eloToRank(after);
    const next: SaveData = {
      ...cur.save,
      rev: cur.save.rev + 1,
      updatedAt: now(),
      pvp: {
        ...pvp,
        elo: after,
        rank,
        streak: nextStreak(pvp.streak, won),
        wins: pvp.wins + (won ? 1 : 0),
        losses: pvp.losses + (won ? 0 : 1),
      },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: cur.rev },
      { $set: { save: next, rev: next.rev } },
      { returnDocument: 'after' },
    );
    if (res) return { delta: appliedDelta, after, rankAfter: rank };
    // rev 冲突（客户端并发 PUT /save）→ 重读重试
  }
  return null;
}
