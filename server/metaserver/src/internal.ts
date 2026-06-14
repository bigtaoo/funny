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
} from '@nw/shared';

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
}

export function registerInternalRoutes(app: FastifyInstance, deps: InternalDeps): void {
  const { cols, internalKey, now } = deps;

  const authed = (key: unknown): boolean => key === internalKey;

  // ── GET /internal/elo?accountId= ──────────────────────────────────────
  app.get('/internal/elo', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const accountId = (req.query as { accountId?: string }).accountId;
    if (!accountId) return reply.code(400).send({ ok: false, error: 'accountId required' });
    const doc = await cols.saves.findOne({ _id: accountId });
    return reply.send({ elo: doc?.save.pvp.elo ?? INITIAL_ELO });
  });

  // ── POST /internal/match/report ───────────────────────────────────────
  app.post('/internal/match/report', async (req, reply) => {
    if (!authed(req.headers['x-internal-key'])) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const body = req.body as ReportBody;
    if (!body?.room_id) return reply.code(400).send({ ok: false, error: 'room_id required' });

    // 幂等：同 room_id 已归档则直接 ok（重发不重复结算）。
    const existing = await cols.matches.findOne({ roomId: body.room_id });
    if (existing) return reply.send({ ok: true });

    // ranked + 有胜方 + 未作废（base/disconnect）→ 服务器权威结算 ELO。
    const settleRanked =
      body.mode === 'ranked' && body.winner_side >= 0 && body.reason !== 'mismatch';
    let eloBySide: Record<number, EloResult> | null = null;
    if (settleRanked) {
      const winner = body.players.find((p) => p.side === body.winner_side);
      const loser = body.players.find((p) => p.side !== body.winner_side);
      if (winner && loser) {
        try {
          eloBySide = await settleElo(cols, now, winner, loser);
        } catch (e) {
          app.log.error({ err: e }, 'ranked ELO settle failed');
        }
      }
    }

    // 归档 matches（内嵌录像 / 大局 replayRef 待办）。winner -1 = 未知（friendly 正常结束）。
    await cols.matches
      .insertOne({
        roomId: body.room_id,
        mode: body.mode,
        seed: body.seed,
        players: body.players,
        winner: body.winner_side,
        reason: body.reason,
        hashOk: body.hash_ok,
        replay: {
          engineVersion: body.replay.engineVersion,
          mode: body.replay.mode,
          seed: body.replay.seed,
          endFrame: body.replay.endFrame,
          frames: body.replay.frames, // cmds[].commands 为 base64 opaque（不解码 M12）
          meta: body.replay.meta,
        },
        ts: now(),
      })
      .catch((e) => {
        // 幂等竞态：唯一索引冲突说明并发已归档，忽略。
        if ((e as { code?: number }).code !== 11000) app.log.error({ err: e }, 'archive match failed');
      });

    return reply.send({ ok: true, ...(eloBySide ? { elo: eloBySide } : {}) });
  });
}

/** 双方 ELO 结算：读分 → 算分差 → 各自原子写 saves.pvp（乐观锁 rev 守卫 + 重试）。 */
async function settleElo(
  cols: Collections,
  now: () => number,
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
