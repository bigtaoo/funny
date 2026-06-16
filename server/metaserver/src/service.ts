// metaserver serviceHandlers：openapi.yml 的 operationId → 方法（fastify-openapi-glue 装配）。
// 校验/路由由 glue 按 spec 完成；此处只做业务。S0 实现 auth + save；
// 经济/盲盒/IAP（S2/S4）先返回 NOT_IMPLEMENTED 占位，契约已就绪。
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collections, JwtConfig, SyncPatch, SaveData } from '@nw/shared';
import { ErrorCode, err, ok, signToken } from '@nw/shared';
import {
  findPveLevel,
  findPveUpgrade,
  pveUpgradeCost,
  PVE_DAILY_CLEAR_REWARD_CAP,
  shouldSpotCheck,
} from '@nw/shared';
import { validateLoginId, validatePassword, validateDisplayName } from '@nw/shared';
import {
  SHOP_ITEMS,
  GACHA_POOLS,
  findShopItem,
  findGachaPool,
  poolEntries,
  gachaCost,
  ADS_REWARD_COINS,
  ADS_DAILY_CAP,
  RENAME_COST,
} from '@nw/shared';
import { getOrCreateSave, putSave } from './save.js';
import {
  changePassword,
  ensurePublicId,
  exchangeWxCode,
  getDisplayName,
  getProfile,
  loginWithPassword,
  registerWithPassword,
  resolveByDevice,
  resolveByOpenid,
  setDisplayName,
} from './accounts.js';
import {
  getFriends,
  listRequests,
  resolveByPublicId,
  requestFriend,
  respondFriend,
  removeFriend,
  blockUser,
  unblockUser,
  friendAccountIds,
  type SocialError,
} from './social.js';
import type { CommercialClient } from './commercialClient.js';
import type { GatewayClient } from './gatewayClient.js';
import {
  markDuplicates,
  deliverGrant,
  mirrorCoins,
  mirrorWalletFrom,
  reconcileUndelivered,
  adsDayKey,
  bumpAdsCap,
} from './economy.js';

export interface ServiceDeps {
  cols: Collections;
  jwt: JwtConfig;
  now: () => number;
  commercial: CommercialClient;
  /** gateway 公开 WS 地址，随 auth/save 回包下发；null = 不下发（客户端退回自身配置）。 */
  gatewayPublicUrl: string | null;
  /** gateway 内部客户端：PvE L1 录像抽检经 /gw/judge 派第三方无头复算。未配置则不抽检（直接发材料）。 */
  gateway: GatewayClient;
}

/** 取安全处理器写入的 accountId（security handler 保证已鉴权）。 */
function accountIdOf(req: FastifyRequest): string {
  const id = req.accountId;
  if (!id) throw new Error('accountId missing after auth');
  return id;
}

/** 规范化升级表（去 0 值 + 排序键）便于跨来源稳定比较（L0 蓝图异常判定）。 */
function normUpgrades(u: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(u).sort()) {
    const v = u[k] ?? 0;
    if (v > 0) out[k] = v;
  }
  return out;
}

export class MetaService {
  constructor(private readonly deps: ServiceDeps) {}

  /** gateway 公开 WS 地址（配置了才下发）。客户端据此连控制面，无需自身硬编码 gateway 地址。 */
  private get gatewayField(): { gatewayUrl?: string } {
    return this.deps.gatewayPublicUrl ? { gatewayUrl: this.deps.gatewayPublicUrl } : {};
  }

  // ── auth ──────────────────────────────────────────
  async authWx(req: FastifyRequest) {
    const { code } = req.body as { code: string };
    const openid = await exchangeWxCode(code);
    const { accountId, isNew, isAnonymous, displayName } = await resolveByOpenid(
      this.deps.cols,
      openid,
      this.deps.now(),
    );
    const token = signToken(accountId, this.deps.jwt);
    const publicId = await ensurePublicId(this.deps.cols, accountId);
    return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async authDevice(req: FastifyRequest) {
    const { deviceId } = req.body as { deviceId: string };
    const { accountId, isNew, isAnonymous, displayName } = await resolveByDevice(
      this.deps.cols,
      deviceId,
      this.deps.now(),
    );
    const token = signToken(accountId, this.deps.jwt);
    const publicId = await ensurePublicId(this.deps.cols, accountId);
    return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async authRegister(req: FastifyRequest, reply: FastifyReply) {
    const { loginId, password, displayName } = req.body as {
      loginId: string;
      password: string;
      displayName?: string;
    };
    const idErr = validateLoginId(loginId);
    if (idErr) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, idErr));
    const pwErr = validatePassword(password);
    if (pwErr) return reply.code(400).send(err(ErrorCode.WEAK_PASSWORD, pwErr));

    const result = await registerWithPassword(
      this.deps.cols,
      loginId,
      password,
      displayName,
      this.deps.now(),
    );
    if (result.kind === 'taken') {
      return reply.code(409).send(err(ErrorCode.LOGIN_ID_TAKEN, 'loginId already registered'));
    }
    const { accountId, isNew, isAnonymous } = result.account;
    const token = signToken(accountId, this.deps.jwt);
    const publicId = await ensurePublicId(this.deps.cols, accountId);
    return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async authLogin(req: FastifyRequest, reply: FastifyReply) {
    const { loginId, password } = req.body as { loginId: string; password: string };
    const account = await loginWithPassword(this.deps.cols, loginId, password);
    if (!account) {
      return reply.code(401).send(err(ErrorCode.INVALID_CREDENTIALS, 'invalid loginId or password'));
    }
    const { accountId, isNew, isAnonymous, displayName } = account;
    const token = signToken(accountId, this.deps.jwt);
    const publicId = await ensurePublicId(this.deps.cols, accountId);
    return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async authPasswordChange(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { oldPassword, newPassword } = req.body as {
      oldPassword: string;
      newPassword: string;
    };
    const pwErr = validatePassword(newPassword);
    if (pwErr) return reply.code(400).send(err(ErrorCode.WEAK_PASSWORD, pwErr));
    const result = await changePassword(this.deps.cols, accountId, oldPassword, newPassword);
    if (result === 'no-password') {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'account has no password credential'));
    }
    if (result === 'invalid') {
      return reply.code(401).send(err(ErrorCode.INVALID_CREDENTIALS, 'old password mismatch'));
    }
    return ok({ ok: true });
  }

  // ── profile ───────────────────────────────────────
  /**
   * 改展示名（消耗 RENAME_COST 金币）。先 commercial 扣币（余额不足则名不变），
   * 扣成功后写新名 + 钱包镜像回推权威存档 + 返回新 displayName。需登录 + commercial 可用。
   */
  async profileRename(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { displayName } = req.body as { displayName: string };
    const nameErr = validateDisplayName(displayName);
    if (nameErr) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, nameErr));
    const name = displayName.trim();

    const { cols, commercial, now } = this.deps;
    const orderId = randomUUID();
    const charge = await commercial.spend({ accountId, amount: RENAME_COST, reason: 'rename', orderId });
    if (!charge.ok) {
      if (charge.error === 'INSUFFICIENT_FUNDS') {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, charge.error));
    }
    await setDisplayName(cols, accountId, name);
    const save = await mirrorCoins(cols, accountId, charge.coinsAfter, now());
    return ok({ save, displayName: name });
  }

  // ── save ──────────────────────────────────────────
  async getSave(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { cols, commercial, now } = this.deps;
    await getOrCreateSave(cols, accountId, now()); // 确保存档存在
    // 顺带对账 + 钱包镜像刷新（commercial 可用时）：补发崩溃遗留订单 + 拉权威余额/pity 写镜像。
    if (commercial.available) {
      try {
        await reconcileUndelivered(cols, commercial, accountId, now());
        const w = await commercial.getWallet(accountId);
        if (w) await mirrorWalletFrom(cols, accountId, w.coins, w.pity, now());
      } catch (e) {
        req.log.warn({ err: e }, 'commercial reconcile/mirror failed (serving local save)');
      }
    }
    const save = await getOrCreateSave(cols, accountId, now());
    const displayName = await getDisplayName(cols, accountId);
    const publicId = await ensurePublicId(cols, accountId);
    return ok({ save, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async putSave(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const ifMatch = req.headers['if-match'];
    const clientRev = Number(Array.isArray(ifMatch) ? ifMatch[0] : ifMatch);
    if (!Number.isFinite(clientRev)) {
      return reply
        .code(400)
        .send(err(ErrorCode.BAD_REQUEST, 'If-Match header must be a numeric rev'));
    }
    const { save: patch } = req.body as { save: SyncPatch };
    const result = await putSave(
      this.deps.cols,
      accountId,
      clientRev,
      patch,
      this.deps.now(),
    );
    if (result.kind === 'conflict') {
      return reply.code(409).send({
        ok: false,
        error: { code: ErrorCode.REV_CONFLICT, message: 'rev conflict' },
        save: result.save,
      });
    }
    return ok({ save: result.save });
  }

  // ── PvE 服务器权威（PVE_INTEGRITY_PLAN §8）：通关结算 + 升级。progress/stars/materials/
  //    pveUpgrades 只由此处 + ranked 结算写，putSave 不接受（信任边界，§8.3）。──────────

  /** 乐观锁读-改-写存档（rev 守卫 + 重试，同 applyPvp）。transform 返回新 save 或业务错误码字符串。 */
  private async mutateSave(
    accountId: string,
    transform: (s: SaveData) => SaveData | string,
  ): Promise<{ save: SaveData } | { error: string }> {
    const { cols, now } = this.deps;
    await getOrCreateSave(cols, accountId, now());
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) return { error: 'NOT_FOUND' };
      const out = transform(doc.save);
      if (typeof out === 'string') return { error: out };
      const next: SaveData = { ...out, rev: doc.save.rev + 1, updatedAt: now() };
      const res = await cols.saves.findOneAndUpdate(
        { _id: accountId, rev: doc.rev },
        { $set: { save: next, rev: next.rev } },
        { returnDocument: 'after' },
      );
      if (res) return { save: res.save };
      // rev 冲突（客户端并发 PUT equipped/flags 或并发 pve 写）→ 重读重试
    }
    return { error: 'REV_CONFLICT' };
  }

  /** 当日「发材料的通关」次数 +1（< cap 才占格并返 true），同 bumpAdsCap 两步法。 */
  private async bumpPveRewardCap(accountId: string, now: number): Promise<boolean> {
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const id = `${accountId}:${dayKey}`;
    await this.deps.cols.pveDaily.updateOne(
      { _id: id },
      { $setOnInsert: { _id: id, accountId, dayKey, rewardedClears: 0, ts: now } },
      { upsert: true },
    );
    const res = await this.deps.cols.pveDaily.findOneAndUpdate(
      { _id: id, rewardedClears: { $lt: PVE_DAILY_CLEAR_REWARD_CAP } },
      { $inc: { rewardedClears: 1 }, $set: { ts: now } },
      { returnDocument: 'after' },
    );
    return !!res;
  }

  /** 写 progress/stars（解锁 + 记星，取 max），不动 materials。 */
  private async writeClearProgress(accountId: string, levelId: string, stars: number) {
    return this.mutateSave(accountId, (s) => {
      const cleared = s.progress.cleared.includes(levelId)
        ? s.progress.cleared
        : [...s.progress.cleared, levelId];
      const stars2 = Math.max(s.progress.stars[levelId] ?? 0, stars) as 1 | 2 | 3;
      return {
        ...s,
        progress: { ...s.progress, cleared, stars: { ...s.progress.stars, [levelId]: stars2 } },
      };
    });
  }

  /** 当日上限内发材料（reward 已是权威表）。返回实发 reward（capped → {}）+ 是否 capped + 回推 save。 */
  private async grantClearReward(
    accountId: string,
    reward: Record<string, number>,
  ): Promise<{ save: SaveData; granted: Record<string, number>; capped: boolean } | { error: string }> {
    const hasReward = Object.keys(reward).length > 0;
    const capped = hasReward ? !(await this.bumpPveRewardCap(accountId, this.deps.now())) : false;
    const grant: Record<string, number> = capped ? {} : { ...reward };
    const out = await this.mutateSave(accountId, (s) => {
      const materials = { ...s.materials };
      for (const [m, n] of Object.entries(grant)) materials[m] = (materials[m] ?? 0) + n;
      return { ...s, materials };
    });
    if ('error' in out) return out;
    return { save: out.save, granted: grant, capped };
  }

  /**
   * PvE 通关结算：校验解锁 → 写 progress/stars → 发材料（当日上限内）→ 回推。
   * L1 抽检（§8.6 第 3 步）：被抽中（首通 / 蓝图异常 / 随机）且裁判可用时 **暂不发材料**，
   * 记 pveVerifications 并回执 `needsReplay + verifyId`，由客户端补传录像走 /pve/verify 复算入账。
   */
  async pveClear(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols, now, gateway } = this.deps;
    const { levelId, stars: starsRaw, pveUpgrades: clientUpgrades } = req.body as {
      levelId: string;
      stars: number;
      pveUpgrades?: Record<string, number>;
    };
    const level = findPveLevel(levelId);
    if (!level) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown level'));
    const stars = Math.floor(starsRaw);
    if (stars < 1 || stars > 3) {
      // 通关至少 1 星；0 星不算通关（与客户端 applyCampaignClear 的 stars>0 门一致）。
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'stars must be 1..3'));
    }

    const cur = await getOrCreateSave(cols, accountId, now());
    // 解锁前置：前置关须已通关（离线新解锁被拒，§8 决策 4）。
    if (level.requires && !cur.progress.cleared.includes(level.requires)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'level locked'));
    }
    const hasReward = Object.keys(level.reward).length > 0;

    // L1 抽检决策：仅在「有材料可发 + 裁判可用」时考虑（否则没有可被作弊套利的产出）。
    if (hasReward && gateway.available) {
      const isFirstClear = !cur.progress.cleared.includes(levelId);
      // L0 异常（§0「开局战力不符 → 必作弊」）：客户端上报蓝图快照与服务器权威 pveUpgrades 不符。
      const blueprintMismatch =
        clientUpgrades !== undefined &&
        JSON.stringify(normUpgrades(clientUpgrades)) !== JSON.stringify(normUpgrades(cur.pveUpgrades));
      if (shouldSpotCheck({ isFirstClear, blueprintMismatch, rand: Math.random() })) {
        const reason = blueprintMismatch ? 'anomaly' : isFirstClear ? 'first' : 'sample';
        // 写 progress/stars（解锁照常）但不发材料；记抽检，等客户端补传录像复算。
        const prog = await this.writeClearProgress(accountId, levelId, stars);
        if ('error' in prog) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, prog.error));
        const verifyId = randomUUID();
        await cols.pveVerifications.insertOne({
          _id: verifyId,
          accountId,
          levelId,
          claimedStars: stars,
          pveUpgrades: { ...cur.pveUpgrades }, // 服务器权威蓝图快照（复算用，防漂移）
          reason,
          status: 'pending',
          ts: now(),
        });
        return ok({ save: prog.save, granted: {}, capped: false, needsReplay: true, verifyId });
      }
    }

    // 普通通关：写 progress/stars 后发材料（当日上限内）。
    const prog = await this.writeClearProgress(accountId, levelId, stars);
    if ('error' in prog) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, prog.error));
    const granted = await this.grantClearReward(accountId, level.reward);
    if ('error' in granted) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, granted.error));
    return ok({ save: granted.save, granted: granted.granted, capped: granted.capped });
  }

  /**
   * PvE L1 录像抽检复算（§8.6 第 3 步）：客户端补传被抽中通关的录像帧 → 经 gateway 派第三方
   * 在线客户端无头复算（复用 S1-J，战役模式 + 服务器权威蓝图快照）→ 复算星数 ≥ 声称才发材料。
   * 无裁判可裁（无候选 / 超时 / 复算失败）→ benefit-of-doubt 照发（不因缺裁判惩罚诚实玩家）；
   * 复算星数 < 声称 → 判为可疑，不发材料 + 记 rejected。
   */
  async pveVerify(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols, gateway, now } = this.deps;
    const { verifyId, frames, endFrame } = req.body as {
      verifyId: string;
      frames: { frame: number; cmds: { side: number; commands: string }[] }[];
      endFrame: number;
    };
    const doc = await cols.pveVerifications.findOne({ _id: verifyId });
    if (!doc || doc.accountId !== accountId) {
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'verification not found'));
    }
    if (doc.status !== 'pending') {
      // 已结算（重复上传）→ 幂等：回当前 save，不再发。
      const s = await getOrCreateSave(cols, accountId, now());
      return ok({ save: s, granted: {}, capped: false, verified: doc.status !== 'rejected' });
    }
    const level = findPveLevel(doc.levelId);
    if (!level) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown level'));

    // 派第三方无头复算（seed 由裁判本地查关卡 JSON 派生；mode 仅审计，PvE 看 levelId）。
    const verdict = await gateway.judge({
      seed: 0,
      mode: 0,
      endFrame: Math.floor(endFrame) || 0,
      frames: frames ?? [],
      exclude: [accountId],
      levelId: doc.levelId,
      pveUpgrades: doc.pveUpgrades,
    });

    const judgedStars = verdict.stars ?? 0;
    // 复算成功且星数 < 声称 → 可疑，不发材料。其余（通过 / 无裁判可裁）发材料。
    const rejected = verdict.ok && judgedStars < doc.claimedStars;
    const status: 'verified' | 'unverified' | 'rejected' = rejected
      ? 'rejected'
      : verdict.ok
        ? 'verified'
        : 'unverified';
    await cols.pveVerifications.updateOne(
      { _id: verifyId, status: 'pending' },
      {
        $set: {
          status,
          judgedStars,
          ...(verdict.judgeAccountId ? { judgeAccountId: verdict.judgeAccountId } : {}),
        },
      },
    );

    if (rejected) {
      const s = await getOrCreateSave(cols, accountId, now());
      return ok({ save: s, granted: {}, capped: false, verified: false });
    }
    const granted = await this.grantClearReward(accountId, level.reward);
    if ('error' in granted) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, granted.error));
    return ok({ save: granted.save, granted: granted.granted, capped: granted.capped, verified: true });
  }

  /** PvE 升级：服务器校验材料足够 → 扣材料 + pveUpgrades+1 → 回推（仅在线）。 */
  async pveUpgrade(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { upgradeId } = req.body as { upgradeId: string };
    const def = findPveUpgrade(upgradeId);
    if (!def) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown upgrade'));

    const out = await this.mutateSave(accountId, (s) => {
      const lvl = s.pveUpgrades[upgradeId] ?? 0;
      const cost = pveUpgradeCost(def, lvl);
      if (!cost) return 'MAXED';
      if ((s.materials[cost.material] ?? 0) < cost.amount) return 'INSUFFICIENT';
      return {
        ...s,
        materials: { ...s.materials, [cost.material]: (s.materials[cost.material] ?? 0) - cost.amount },
        pveUpgrades: { ...s.pveUpgrades, [upgradeId]: lvl + 1 },
      };
    });
    if ('error' in out) {
      if (out.error === 'INSUFFICIENT') {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough materials'));
      }
      if (out.error === 'MAXED') {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'upgrade maxed'));
      }
      return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
    }
    return ok({ save: out.save });
  }

  /** 最近对战历史（ranked / friendly），从归档 matches 取当前账号视角的精简摘要。 */
  async getMatchHistory(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { cols } = this.deps;
    const limitRaw = Number((req.query as { limit?: string | number }).limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(50, Math.max(1, Math.floor(limitRaw)))
      : 20;
    const docs = await cols.matches
      .find({ 'players.accountId': accountId })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    const matches = docs.map((d) => {
      const me = d.players.find((p) => p.accountId === accountId);
      const opp = d.players.find((p) => p.accountId !== accountId);
      const result: 'win' | 'loss' | 'unknown' =
        !me || d.winner < 0 ? 'unknown' : d.winner === me.side ? 'win' : 'loss';
      return {
        roomId: d.roomId,
        mode: d.mode,
        result,
        ...(opp?.displayName ? { opponentName: opp.displayName } : {}),
        ...(opp?.publicId ? { opponentPublicId: opp.publicId } : {}),
        ...(me?.eloDelta !== undefined ? { eloDelta: me.eloDelta } : {}),
        ts: d.ts,
      };
    });
    return ok({ matches });
  }

  /** 取某局录像（仅本人参与的对局）；内嵌 replay 优先，大局回退 replayBlobs（S1-RP）。 */
  async getMatchReplay(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols } = this.deps;
    const roomId = (req.params as { roomId?: string }).roomId;
    if (!roomId) {
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'match not found'));
    }
    const doc = await cols.matches.findOne({ roomId });
    // 仅本人参与的对局可取（防越权拉别人录像）。
    if (!doc || !doc.players.some((p) => p.accountId === accountId)) {
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'match not found'));
    }
    let replay = doc.replay;
    if (!replay && doc.replayRef) {
      const blob = await cols.replayBlobs.findOne({ _id: doc.replayRef });
      replay = blob?.replay;
    }
    if (!replay) {
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'replay unavailable'));
    }
    return ok({ replay });
  }

  // ── 社交：好友（S6-1）。meta = 数据权威，写一处；实时投递经 gateway push（离线丢弃）。──
  /** SocialError → HTTP 状态 + ErrorCode。 */
  private sendSocialError(reply: FastifyReply, e: SocialError) {
    switch (e) {
      case 'NOT_FOUND':
        return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'not found'));
      case 'ALREADY_FRIEND':
        return reply.code(409).send(err(ErrorCode.ALREADY_FRIEND, 'already friends'));
      case 'FRIEND_CAP_REACHED':
        return reply.code(409).send(err(ErrorCode.FRIEND_CAP_REACHED, 'friend cap reached'));
      case 'BLOCKED':
        return reply.code(403).send(err(ErrorCode.BLOCKED, 'blocked'));
      case 'BAD_REQUEST':
      default:
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'bad request'));
    }
  }

  async getFriends(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { cols, gateway } = this.deps;
    const friends = await getFriends(cols, accountId);
    // 标在线态：拉好友 accountId → 向 gateway 批量查 presence。需 publicId→accountId 映射回填。
    if (gateway.available && friends.length > 0) {
      const ids = await friendAccountIds(cols, accountId);
      const presence = await gateway.presence(ids);
      // accountId → publicId 映射（仅这批好友）。
      const docs = await cols.accounts
        .find({ _id: { $in: ids } }, { projection: { publicId: 1 } })
        .toArray();
      const byPublic = new Map<string, boolean>();
      for (const d of docs) {
        if (d.publicId) byPublic.set(d.publicId, presence[d._id] ?? false);
      }
      for (const f of friends) f.online = byPublic.get(f.publicId) ?? false;
    }
    return ok({ friends });
  }

  async getFriendRequests(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { incoming, outgoing } = await listRequests(this.deps.cols, accountId);
    return ok({ incoming, outgoing });
  }

  async searchFriend(req: FastifyRequest, reply: FastifyReply) {
    accountIdOf(req); // 须登录
    const { publicId } = req.body as { publicId: string };
    const found = await resolveByPublicId(this.deps.cols, publicId);
    if (!found) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'player not found'));
    return ok({ profile: found.profile });
  }

  async requestFriend(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { publicId, message } = req.body as { publicId: string; message?: string };
    const res = await requestFriend(this.deps.cols, accountId, publicId, message, this.deps.now());
    if (res.kind === 'error') return this.sendSocialError(reply, res.error);
    // 推送给目标（在线则弹申请红点）。
    void this.deps.gateway.push(res.to, {
      kind: 'friend_request',
      requestId: res.requestId,
      fromPublicId: res.fromProfile.publicId,
      fromName: res.fromProfile.displayName,
      message: res.message ?? '',
    });
    return ok({ requestId: res.requestId });
  }

  async respondFriend(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { requestId, accept } = req.body as { requestId: string; accept: boolean };
    const res = await respondFriend(this.deps.cols, accountId, requestId, accept, this.deps.now());
    if (res.kind === 'error') return this.sendSocialError(reply, res.error);
    if (res.accepted) {
      // 好友边变更 → 让 gateway presence 缓存失效（双方）。
      void this.deps.gateway.invalidateFriends(accountId);
      void this.deps.gateway.invalidateFriends(res.otherAccountId);
      // 通知双方好友已建立（各自 push 对方的 publicId）。
      void this.deps.gateway.push(res.otherAccountId, {
        kind: 'friend_update',
        publicId: res.meProfile.publicId,
        added: true,
      });
      void this.deps.gateway.push(accountId, {
        kind: 'friend_update',
        publicId: res.otherProfile.publicId,
        added: true,
      });
    }
    return ok({ ok: true });
  }

  async removeFriend(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { publicId } = req.params as { publicId: string };
    const res = await removeFriend(this.deps.cols, accountId, publicId);
    if (res) {
      void this.deps.gateway.invalidateFriends(accountId);
      void this.deps.gateway.invalidateFriends(res.otherAccountId);
      const me = await getProfile(this.deps.cols, accountId);
      void this.deps.gateway.push(res.otherAccountId, {
        kind: 'friend_update',
        publicId: me.publicId,
        added: false,
      });
    }
    return ok({ ok: true });
  }

  async blockUser(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { publicId } = req.body as { publicId: string };
    const res = await blockUser(this.deps.cols, accountId, publicId, this.deps.now());
    if (!res) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'player not found'));
    void this.deps.gateway.invalidateFriends(accountId);
    void this.deps.gateway.invalidateFriends(res.otherAccountId);
    const me = await getProfile(this.deps.cols, accountId);
    void this.deps.gateway.push(res.otherAccountId, {
      kind: 'friend_update',
      publicId: me.publicId,
      added: false,
    });
    return ok({ ok: true });
  }

  async unblockUser(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { publicId } = req.params as { publicId: string };
    await unblockUser(this.deps.cols, accountId, publicId);
    return ok({ ok: true });
  }

  // ── economy（S5：meta 编排 → commercial 扣币/随机 → 发货 → 镜像回推）──────
  /** commercial 未配置时经济端点不可用（503）。 */
  private ensureCommercial(reply: FastifyReply): boolean {
    if (this.deps.commercial.available) return true;
    reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'commercial service unavailable'));
    return false;
  }

  /** 商品列表（catalog 单一来源 @nw/shared）。 */
  async getShopItems() {
    const items = SHOP_ITEMS.map((i) => ({
      id: i.id,
      cost: i.cost,
      kind: i.kind,
      grants: i.grants,
    }));
    return ok({ items });
  }

  /** 盲盒池列表（展开 entries 供客户端展示）。 */
  async getGachaPools() {
    const pools = GACHA_POOLS.map((p) => ({
      id: p.id,
      costSingle: p.costSingle,
      costTen: p.costTen,
      pityThreshold: p.pityThreshold,
      dupePolicy: p.dupePolicy,
      entries: poolEntries(p),
    }));
    return ok({ pools });
  }

  async shopBuy(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { itemId } = req.body as { itemId: string };
    const def = findShopItem(itemId);
    if (!def) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown item'));

    const { cols, commercial, now } = this.deps;
    const orderId = randomUUID();
    const charge = await commercial.shopCharge({ accountId, itemId, cost: def.cost, orderId });
    if (!charge.ok) {
      if (charge.error === 'INSUFFICIENT_FUNDS') {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, charge.error));
    }
    // 发货：皮肤幂等加进 inventory + 标 delivered + 钱包镜像。
    const cur = await getOrCreateSave(cols, accountId, now());
    const newSkins = cur.inventory.skins.includes(def.grants) ? [] : [def.grants];
    const save = await deliverGrant(cols, accountId, orderId, newSkins, charge.coinsAfter, null, now());
    await commercial.orderDelivered({ orderId });
    return ok({ save, granted: def.grants });
  }

  async gachaDraw(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { poolId, count } = req.body as { poolId: string; count: number };
    const pool = findGachaPool(poolId);
    if (!pool || (count !== 1 && count !== 10)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid pool/count'));
    }
    void gachaCost; // 成本权威在 commercial（按池算）；此处仅校验池与抽数。

    const { cols, commercial, now } = this.deps;
    const orderId = randomUUID();
    const draw = await commercial.gachaDraw({ accountId, poolId, count, orderId });
    if (!draw.ok) {
      if (draw.error === 'INSUFFICIENT_FUNDS') {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, draw.error));
    }
    // 发货：新皮肤进 inventory（幂等），重复转化 S5 暂缓（见 economy.ts 注释）。
    const cur = await getOrCreateSave(cols, accountId, now());
    const { newSkins, marked } = markDuplicates(cur.inventory.skins, draw.results);
    const save = await deliverGrant(
      cols,
      accountId,
      orderId,
      newSkins,
      draw.coinsAfter,
      { [poolId]: draw.pityAfter },
      now(),
    );
    await commercial.orderDelivered({ orderId });
    return ok({ save, results: marked });
  }

  async adsReward(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { adToken } = req.body as { adToken: string };
    // dev 桩：校验广告凭证非空（真实广告平台回调验签待接）。
    if (!adToken) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing adToken'));

    const { cols, commercial, now } = this.deps;
    const dayKey = adsDayKey(now());
    const allowed = await bumpAdsCap(cols, accountId, dayKey, ADS_DAILY_CAP, now());
    if (!allowed) {
      return reply.code(429).send(err(ErrorCode.DAILY_CAP_REACHED, 'daily ad cap reached'));
    }
    const credit = await commercial.adsCredit({ accountId, amount: ADS_REWARD_COINS, dayKey });
    if (!credit.ok) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, credit.error));
    const save = await mirrorCoins(cols, accountId, credit.coinsAfter, now());
    return ok({ save, granted: ADS_REWARD_COINS });
  }

  async iapVerify(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { platform, receipt } = req.body as { platform: string; receipt: string };
    if (!platform || !receipt) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing platform/receipt'));
    }
    const { cols, commercial, now } = this.deps;
    // receiptId = 平台票据唯一 id（幂等键）。dev 桩用 platform:receipt；真实接渠道时取平台事务号。
    const receiptId = `${platform}:${receipt}`;
    const v = await commercial.rechargeVerify({ accountId, platform, receipt, receiptId });
    if (!v.ok) {
      if (v.error === 'INVALID_RECEIPT') {
        return reply.code(400).send(err(ErrorCode.INVALID_RECEIPT, 'receipt rejected'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, v.error));
    }
    const save = await mirrorCoins(cols, accountId, v.coinsAfter, now());
    return ok({ save, granted: v.coinsGranted });
  }
}
