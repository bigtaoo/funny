// metaserver serviceHandlers：openapi.yml 的 operationId → 方法（fastify-openapi-glue 装配）。
// 校验/路由由 glue 按 spec 完成；此处只做业务。S0 实现 auth + save；
// 经济/盲盒/IAP（S2/S4）先返回 NOT_IMPLEMENTED 占位，契约已就绪。
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collections, JwtConfig, SyncPatch, SaveData } from '@nw/shared';
import { ErrorCode, ERROR_HTTP_STATUS, err, ok, signToken } from '@nw/shared';
import {
  findPveLevel,
  findPveUpgrade,
  pveUpgradeCost,
  PVE_DAILY_CLEAR_REWARD_CAP,
  PVE_REJECT_BAN_THRESHOLD,
  shouldSpotCheck,
  chaptersClearedCount,
  sanitizePvpReportedStats,
  accrueStats,
  applyCardMerge,
  deriveUnitLevels,
  grantCards,
  levelCardReward,
  UNIT_CARD_POOL_ID,
  makeDropInstance,
  EQUIPMENT_INV_CAP,
  equipmentInvCount,
  type EquipmentInstance,
  BATTLEPASS_BUY_COST,
  makeFreshBattlePass,
  claimBpReward,
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
  ADS_MIN_INTERVAL_MS,
  RENAME_COST,
} from '@nw/shared';
import { CHAT_SEND_RATE_PER_MIN, regionFromAcceptLanguage } from '@nw/shared';
import { ACHIEVEMENTS, findAchievement, validateClaim } from '@nw/shared';
import { getOrCreateSave, putSave, writeMigratedSave } from './save.js';
import { getCurrentSeason, migrateIfStale } from './ladderSeason.js';
import { craftEquipment, enhanceEquipment, salvageEquipment, equipEquipment, reforgeEquipment } from './equipment.js';
import {
  bindOAuth,
  bindPassword,
  changePassword,
  ensurePublicId,
  exchangeWxCode,
  getDisplayName,
  getProfile,
  getRegion,
  loginWithPassword,
  registerWithPassword,
  resolveByDevice,
  resolveByOAuth,
  resolveByOpenid,
  setDisplayName,
} from './accounts.js';
import { createOAuthService, OAuthError, type OAuthProvider } from './oauth.js';
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
  sendMessage,
  getConversations,
  getMessages,
  markConversationRead,
  socialBadges,
  profileOf,
  type SocialError,
} from './social.js';
import {
  getMail,
  readMail,
  deleteMail,
  claimMailAtomic,
  splitAttachments,
  sendPlayerMail,
  insertSystemMail,
} from './mail.js';
import type { CommercialClient } from './commercialClient.js';
import type { GatewayClient } from './gatewayClient.js';
import {
  markDuplicates,
  deliverGrant,
  deliverCardGrant,
  deliverMailGrant,
  mirrorCoins,
  mirrorWalletFrom,
  reconcileUndelivered,
  adsDayKey,
  bumpAdsCap,
  hashAdToken,
  recordAdToken,
  checkAdInterval,
} from './economy.js';
import { grantTitleToPlayer } from './titles.js';
import { verifyAdPlatformToken } from './ads.js';

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

/** 进程内 IP/key 维度滑窗限流。 */
class SlidingRateLimiter {
  private readonly windows = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now: number): boolean {
    const win = this.windows.get(key)?.filter((t) => now - t < this.windowMs) ?? [];
    if (win.length >= this.limit) {
      this.windows.set(key, win);
      return false;
    }
    win.push(now);
    this.windows.set(key, win);
    return true;
  }
}

export class MetaService {
  private readonly oauth = createOAuthService();

  constructor(private readonly deps: ServiceDeps) {}

  /**
   * 私聊发送限流（SOC2）：每账号近 60s 的发送时间戳滑窗。进程内（meta 无状态横扩时是 per-instance
   * 近似限流，足以挡刷屏；精确全局限流待 Redis）。返回 true=允许并记一次，false=超限。
   */
  private readonly chatRate = new Map<string, number[]>();
  private allowChat(accountId: string, now: number): boolean {
    const win = this.chatRate.get(accountId)?.filter((t) => now - t < 60_000) ?? [];
    if (win.length >= CHAT_SEND_RATE_PER_MIN) {
      this.chatRate.set(accountId, win);
      return false;
    }
    win.push(now);
    this.chatRate.set(accountId, win);
    return true;
  }

  /**
   * 登录/注册 IP 限流（S4-3）：每 IP 15 分钟内最多 20 次 auth 尝试（阻止暴力撞库）。
   * 进程内近似（横扩时是 per-instance，足以抵御单机撞库；精确全局限流待 Redis）。
   */
  private readonly authRate = new SlidingRateLimiter(20, 15 * 60 * 1000);
  private allowAuthAttempt(req: FastifyRequest, now: number): boolean {
    const ip = req.ip ?? 'unknown';
    return this.authRate.allow(ip, now);
  }

  /** gateway 公开 WS 地址（配置了才下发）。客户端据此连控制面，无需自身硬编码 gateway 地址。 */
  private get gatewayField(): { gatewayUrl?: string } {
    return this.deps.gatewayPublicUrl ? { gatewayUrl: this.deps.gatewayPublicUrl } : {};
  }

  // ── auth ──────────────────────────────────────────

  /** C4：检查账号级封号标记（accounts.flags.banned），封号则 reject。 */
  private async rejectIfBanned(cols: typeof this.deps.cols, accountId: string, reply: FastifyReply): Promise<boolean> {
    const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { flags: 1 } });
    if (doc?.flags?.banned) {
      void reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account banned'));
      return true;
    }
    return false;
  }

  async authWx(req: FastifyRequest, reply: FastifyReply) {
    const { code } = req.body as { code: string };
    const openid = await exchangeWxCode(code);
    const region = regionFromAcceptLanguage(req.headers['accept-language']);
    const { accountId, isNew, isAnonymous, displayName } = await resolveByOpenid(
      this.deps.cols,
      openid,
      this.deps.now(),
      region,
    );
    if (await this.rejectIfBanned(this.deps.cols, accountId, reply)) return;
    const token = signToken(accountId, this.deps.jwt);
    const publicId = await ensurePublicId(this.deps.cols, accountId);
    return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async authDevice(req: FastifyRequest, reply: FastifyReply) {
    const { deviceId } = req.body as { deviceId: string };
    const region = regionFromAcceptLanguage(req.headers['accept-language']);
    const { accountId, isNew, isAnonymous, displayName } = await resolveByDevice(
      this.deps.cols,
      deviceId,
      this.deps.now(),
      region,
    );
    if (await this.rejectIfBanned(this.deps.cols, accountId, reply)) return;
    const token = signToken(accountId, this.deps.jwt);
    const publicId = await ensurePublicId(this.deps.cols, accountId);
    return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...this.gatewayField });
  }

  async authRegister(req: FastifyRequest, reply: FastifyReply) {
    if (!this.allowAuthAttempt(req, this.deps.now())) {
      return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many auth attempts, try later'));
    }
    const { loginId, password, displayName } = req.body as {
      loginId: string;
      password: string;
      displayName?: string;
    };
    const idErr = validateLoginId(loginId);
    if (idErr) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, idErr));
    const pwErr = validatePassword(password);
    if (pwErr) return reply.code(400).send(err(ErrorCode.WEAK_PASSWORD, pwErr));

    const region = regionFromAcceptLanguage(req.headers['accept-language']);
    const result = await registerWithPassword(
      this.deps.cols,
      loginId,
      password,
      displayName,
      this.deps.now(),
      region,
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
    if (!this.allowAuthAttempt(req, this.deps.now())) {
      return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many auth attempts, try later'));
    }
    const { loginId, password } = req.body as { loginId: string; password: string };
    const region = regionFromAcceptLanguage(req.headers['accept-language']);
    const account = await loginWithPassword(this.deps.cols, loginId, password, region);
    if (!account) {
      return reply.code(401).send(err(ErrorCode.INVALID_CREDENTIALS, 'invalid loginId or password'));
    }
    const { accountId, isNew, isAnonymous, displayName } = account;
    if (await this.rejectIfBanned(this.deps.cols, accountId, reply)) return;
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

  /**
   * OAuth 第三方登录（SA-2）：授权码流，首期支持 Google。
   * 服务端用 code 换 access_token → 取 sub → upsert 账号。
   */
  async authOAuth(req: FastifyRequest, reply: FastifyReply) {
    if (!this.allowAuthAttempt(req, this.deps.now())) {
      return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many auth attempts, try later'));
    }
    const { provider, code, redirectUri } = req.body as {
      provider: string;
      code: string;
      redirectUri: string;
    };
    if (!this.oauth.supports(provider)) {
      return reply
        .code(400)
        .send(err(ErrorCode.OAUTH_FAILED, `unsupported or unconfigured OAuth provider: ${provider}`));
    }
    let sub: string;
    try {
      const result = await this.oauth.exchangeCode(provider as OAuthProvider, code, redirectUri);
      sub = result.sub;
    } catch (e) {
      const msg = e instanceof OAuthError ? e.message : 'OAuth exchange failed';
      return reply.code(400).send(err(ErrorCode.OAUTH_FAILED, msg));
    }
    const region = regionFromAcceptLanguage(req.headers['accept-language']);
    const { accountId, isNew, isAnonymous, displayName } = await resolveByOAuth(
      this.deps.cols,
      provider,
      sub,
      this.deps.now(),
      region,
    );
    if (await this.rejectIfBanned(this.deps.cols, accountId, reply)) return;
    const token = signToken(accountId, this.deps.jwt);
    const publicId = await ensurePublicId(this.deps.cols, accountId);
    return ok({
      token,
      accountId,
      isNew,
      isAnonymous,
      publicId,
      ...(displayName ? { displayName } : {}),
      ...this.gatewayField,
    });
  }

  /**
   * 绑定凭证到当前账号（SA-2）：匿名转正 + 多凭证绑定。
   * method='oauth'：同 authOAuth，但绑到 JWT 指定的已有账号（不建新账号）。
   * method='password'：给账号设密码（已有密码则幂等）。
   * 目标凭证已属另一账号 → ALREADY_BOUND。
   */
  async authBind(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { method } = req.body as { method: string };

    if (method === 'oauth') {
      const { provider, code, redirectUri } = req.body as {
        provider?: string;
        code?: string;
        redirectUri?: string;
      };
      if (!provider || !code || !redirectUri) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'provider, code, redirectUri required for oauth bind'));
      }
      if (!this.oauth.supports(provider)) {
        return reply
          .code(400)
          .send(err(ErrorCode.OAUTH_FAILED, `unsupported or unconfigured OAuth provider: ${provider}`));
      }
      let sub: string;
      try {
        const result = await this.oauth.exchangeCode(provider as OAuthProvider, code, redirectUri);
        sub = result.sub;
      } catch (e) {
        const msg = e instanceof OAuthError ? e.message : 'OAuth exchange failed';
        return reply.code(400).send(err(ErrorCode.OAUTH_FAILED, msg));
      }
      const bindResult = await bindOAuth(this.deps.cols, accountId, provider, sub);
      if (bindResult.kind === 'already_bound') {
        return reply.code(409).send(err(ErrorCode.ALREADY_BOUND, 'credential already bound to another account'));
      }
      return ok({ ok: true, isAnonymous: false });
    }

    if (method === 'password') {
      const { loginId, password } = req.body as { loginId?: string; password?: string };
      if (!loginId || !password) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'loginId and password required for password bind'));
      }
      const idErr = validateLoginId(loginId);
      if (idErr) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, idErr));
      const pwErr = validatePassword(password);
      if (pwErr) return reply.code(400).send(err(ErrorCode.WEAK_PASSWORD, pwErr));

      const bindResult = await bindPassword(this.deps.cols, accountId, loginId, password);
      if (bindResult.kind === 'login_id_taken') {
        return reply.code(409).send(err(ErrorCode.LOGIN_ID_TAKEN, 'loginId already registered to another account'));
      }
      return ok({ ok: true, isAnonymous: false });
    }

    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, `unknown bind method: ${method}`));
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
    let save = await getOrCreateSave(cols, accountId, now());
    // 惰性赛季迁移（S11）：pvp.seasonNo 落后则结算上季奖励 + 软重置 + 更新战令。
    try {
      const currentSeason = await getCurrentSeason(cols, now());
      const r = await migrateIfStale(cols, commercial, save, currentSeason, now());
      if (r.migrated) {
        save = await writeMigratedSave(
          cols,
          r.save,
          now(),
          (s) => migrateIfStale(cols, commercial, s, currentSeason, now()),
        );
      }
    } catch (e) {
      req.log.warn({ err: e }, 'season migrate failed (serving pre-migration save)');
    }
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
      // 成就 stat（S9-3，ACHIEVEMENT_DESIGN §4.2.2）：章节首通累加 campaign.chaptersCleared，
      // 与 progress 同一 mutateSave 事务（rev 守卫），天然权威防伪。$max 语义 → 首通才涨、重打不涨。
      // 缺省懒创建：无章节通关（count=0）且无既有 stats 时不实例化 stats（省存储）。
      const chapters = chaptersClearedCount(cleared);
      const prevChapters = s.stats?.['campaign.chaptersCleared'] ?? 0;
      const stats =
        chapters > prevChapters
          ? { ...(s.stats ?? {}), 'campaign.chaptersCleared': chapters }
          : s.stats;
      return {
        ...s,
        progress: { ...s.progress, cleared, stars: { ...s.progress.stars, [levelId]: stars2 } },
        ...(stats !== s.stats ? { stats } : {}),
      };
    });
  }

  /**
   * PvE 喂入（S9-3b）：把裁判复算回传的本局成就计数（`kill.*`/`cast.*`）累加进玩家终身 stats。
   * statsJson 解析失败 / 非对象 → 跳过；过 {@link sanitizePvpReportedStats}（L1 caps 兜底「串通裁判
   * 刷量」，越界整份丢弃，不阻塞发材料）；空增量懒创建不实例化 stats。失败不抛（喂入是 best-effort
   * 附加，绝不因此卡死发材料主路径——金币池小且一次性，§4.4）。
   */
  private async accrueJudgedPveStats(accountId: string, statsJson: string | undefined): Promise<void> {
    if (!statsJson) return;
    let reported: Record<string, number>;
    try {
      const parsed = JSON.parse(statsJson) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      reported = parsed as Record<string, number>;
    } catch {
      return;
    }
    const clean = sanitizePvpReportedStats(reported);
    if (!clean || Object.keys(clean).length === 0) return; // L1 越界拒收 / 无可累加
    await this.mutateSave(accountId, (s) => {
      const stats = accrueStats(s.stats, clean);
      return stats === s.stats ? s : { ...s, stats };
    });
  }

  /**
   * 当日上限内发关卡产出（材料 reward + 单位卡 levelCardReward，S12-C）。同一每日闸门（材料/卡
   * 同被 cap），同一 mutateSave 事务原子写：materials $+ / cardInventory 经 grantCards / unitLevels
   * 经 deriveUnitLevels 重算（与盲盒/合成同口径，服务器权威）。返回实发（capped → 都空）+ capped + save。
   */
  private async grantClearReward(
    accountId: string,
    levelId: string,
    reward: Record<string, number>,
  ): Promise<{
    save: SaveData;
    granted: Record<string, number>;
    grantedCards: Record<string, number>;
    grantedEquipment?: EquipmentInstance;
    capped: boolean;
  } | { error: string }> {
    const cardReward = levelCardReward(levelId);
    const hasReward = Object.keys(reward).length > 0 || Object.keys(cardReward).length > 0;
    const capped = hasReward ? !(await this.bumpPveRewardCap(accountId, this.deps.now())) : false;
    const grant: Record<string, number> = capped ? {} : { ...reward };
    const cardGrant: Record<string, number> = capped ? {} : { ...cardReward };

    // 装备掉落 roll（独立于每日 cap；先于 mutateSave 在外部 roll，避免事务内 Math.random 不确定性）
    const dropCfg = findPveLevel(levelId)?.equipmentDrop;
    const pendingDrop: EquipmentInstance | undefined =
      dropCfg && Math.random() < dropCfg.rate
        ? (makeDropInstance(dropCfg.rarity, `drop_${randomUUID()}`) as EquipmentInstance)
        : undefined;

    const out = await this.mutateSave(accountId, (s) => {
      const materials = { ...s.materials };
      for (const [m, n] of Object.entries(grant)) materials[m] = (materials[m] ?? 0) + n;
      let next = { ...s, materials };
      if (Object.keys(cardGrant).length > 0) {
        const cardInventory = grantCards(s.cardInventory ?? {}, cardGrant);
        const unitLevels = deriveUnitLevels(cardInventory);
        next = { ...next, cardInventory, unitLevels };
      }
      // 装备入库（满仓时静默跳过）
      if (pendingDrop && equipmentInvCount(next) < EQUIPMENT_INV_CAP) {
        next = { ...next, equipmentInv: { ...(next.equipmentInv ?? {}), [pendingDrop.id]: pendingDrop } };
      }
      return next;
    });
    if ('error' in out) return out;
    // 确认掉落实际写入（满仓时 pendingDrop 未入库）
    const grantedEquipment =
      pendingDrop && out.save.equipmentInv?.[pendingDrop.id] ? pendingDrop : undefined;
    return { save: out.save, granted: grant, grantedCards: cardGrant, grantedEquipment, capped };
  }

  /**
   * PvE 通关结算：校验解锁 → 写 progress/stars → 发材料（当日上限内）→ 回推。
   * L1 抽检（§8.6 第 3 步）：被抽中（首通 / 蓝图异常 / 随机）且裁判可用时 **暂不发材料**，
   * 记 pveVerifications 并回执 `needsReplay + verifyId`，由客户端补传录像走 /pve/verify 复算入账。
   */
  async pveClear(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols, now, gateway } = this.deps;
    const { levelId, stars: starsRaw, pveUpgrades: clientUpgradesLegacy, unitLevels: clientUnitLevels, stats: clientStats } = req.body as {
      levelId: string;
      stars: number;
      /** @deprecated S3-2，S12 起由 unitLevels 替代。 */
      pveUpgrades?: Record<string, number>;
      /** S12 单位养成等级快照（客户端开局快照，用于 L0 异常判定）。 */
      unitLevels?: Record<string, number>;
      /** S9-3b：客户端上报本局 kill/cast 统计（非抽检路径用于成就计数）。 */
      stats?: Record<string, number>;
    };
    const level = findPveLevel(levelId);
    if (!level) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown level'));
    const stars = Math.floor(starsRaw);
    if (stars < 1 || stars > 3) {
      // 通关至少 1 星；0 星不算通关（与客户端 applyCampaignClear 的 stars>0 门一致）。
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'stars must be 1..3'));
    }

    const cur = await getOrCreateSave(cols, accountId, now());
    if (cur.antiCheat?.pveBanned) {
      return reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account banned'));
    }
    // 解锁前置：前置关须已通关（离线新解锁被拒，§8 决策 4）。
    if (level.requires && !cur.progress.cleared.includes(level.requires)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'level locked'));
    }
    // 有可套利产出 = 材料 reward 或单位卡掉落任一非空（S12-C：卡也是可作弊产出）。
    const hasReward =
      Object.keys(level.reward).length > 0 || Object.keys(levelCardReward(levelId)).length > 0;

    // L1 抽检决策：仅在「有产出可发 + 裁判可用」时考虑（否则没有可被作弊套利的产出）。
    if (hasReward && gateway.available) {
      const isFirstClear = !cur.progress.cleared.includes(levelId);
      // L0 异常（§0「开局战力不符 → 必作弊」）：S12 优先比 unitLevels，无则降级比 pveUpgrades。
      const blueprintMismatch = clientUnitLevels !== undefined
        ? JSON.stringify(normUpgrades(clientUnitLevels)) !== JSON.stringify(normUpgrades(cur.unitLevels ?? {}))
        : clientUpgradesLegacy !== undefined &&
          JSON.stringify(normUpgrades(clientUpgradesLegacy)) !== JSON.stringify(normUpgrades(cur.pveUpgrades));
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
          pveUpgrades: { ...cur.pveUpgrades }, // 旧快照（保留兼容）
          unitLevels: { ...(cur.unitLevels ?? {}) }, // S12 服务器权威快照（复算用，防漂移）
          reason,
          status: 'pending',
          ts: now(),
        });
        return ok({
          save: prog.save,
          granted: {},
          grantedCards: {},
          capped: false,
          needsReplay: true,
          verifyId,
        });
      }
    }

    // 普通通关：写 progress/stars 后发材料 + 单位卡（当日上限内，S12-C）。
    const prog = await this.writeClearProgress(accountId, levelId, stars);
    if ('error' in prog) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, prog.error));
    const granted = await this.grantClearReward(accountId, levelId, level.reward);
    if ('error' in granted) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, granted.error));
    // S9-3b：非抽检路径，接受客户端上报统计，过 L1 caps 后写入成就计数器。
    if (clientStats) await this.accrueJudgedPveStats(accountId, JSON.stringify(clientStats));
    return ok({
      save: granted.save,
      granted: granted.granted,
      grantedCards: granted.grantedCards,
      ...(granted.grantedEquipment ? { grantedEquipment: granted.grantedEquipment } : {}),
      capped: granted.capped,
    });
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
      ...(doc.unitLevels ? { unitLevels: doc.unitLevels } : {}),
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
      let banned = false;
      let rejectCount = 1;
      const saved = await this.mutateSave(accountId, (s) => {
        const ac = s.antiCheat ?? { statSuspicion: 0 };
        rejectCount = (ac.pveRejectCount ?? 0) + 1;
        banned = rejectCount >= PVE_REJECT_BAN_THRESHOLD;
        return {
          ...s,
          antiCheat: {
            ...ac,
            pveRejectCount: rejectCount,
            lastFlaggedTs: now(),
            ...(banned ? { pveBanned: true } : {}),
          },
        };
      });
      await cols.pveRejections.insertOne({
        _id: verifyId,
        accountId,
        levelId: doc.levelId,
        claimedStars: doc.claimedStars,
        judgedStars,
        rejectCountAfter: rejectCount,
        banned,
        ts: now(),
      });

      // C4：账号层面 pveWarnings 计数 + 警告邮件 + 封号（auth 层拦截）。
      const updatedAcc = await cols.accounts.findOneAndUpdate(
        { _id: accountId },
        { $inc: { 'flags.pveWarnings': 1 } },
        { returnDocument: 'after', projection: { 'flags.pveWarnings': 1 } },
      );
      const newWarnings = updatedAcc?.flags?.pveWarnings ?? 1;
      if (newWarnings === 1) {
        await insertSystemMail(cols, `pve-warn-${verifyId}`, accountId, {
          subject: 'Fair Play Warning',
          body: 'Unusual PvE activity was detected. Continued violations may result in account suspension.',
          expireDays: 30,
        }, now());
      }
      if (newWarnings >= PVE_REJECT_BAN_THRESHOLD) {
        await cols.accounts.updateOne({ _id: accountId }, { $set: { 'flags.banned': true } });
      }

      const s = 'error' in saved ? await getOrCreateSave(cols, accountId, now()) : saved.save;
      return ok({ save: s, granted: {}, capped: false, verified: false });
    }
    // PvE 喂入（S9-3b，ACHIEVEMENT_DESIGN §6.2）：仅**裁判成功复算**（status==='verified'，非
    // benefit-of-doubt 的 'unverified'）时，把裁判权威产出的本局 kill/cast 累加进终身 stats。
    // 裁判是随机第三方无头复算 → 玩家无法伪造；仍过 L1 caps 作为「玩家串通裁判刷量」的廉价兜底
    // （越界整份丢弃，不阻塞发材料）。A2：计数只在此服务器权威结算点写。
    if (status === 'verified') await this.accrueJudgedPveStats(accountId, verdict.statsJson);
    const granted = await this.grantClearReward(accountId, doc.levelId, level.reward);
    if ('error' in granted) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, granted.error));
    return ok({
      save: granted.save,
      granted: granted.granted,
      grantedCards: granted.grantedCards,
      ...(granted.grantedEquipment ? { grantedEquipment: granted.grantedEquipment } : {}),
      capped: granted.capped,
      verified: true,
    });
  }

  /** S1-RP：为已存 Mongo replayBlob 创建 7 天分享链接（shareId）。 */
  async createReplayShare(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { roomId } = req.params as { roomId: string };
    const { cols, now } = this.deps;
    const blob = await cols.replayBlobs.findOne({ _id: roomId });
    if (!blob) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'replay not found'));
    const shareId = randomUUID();
    const expiresAt = new Date(now() + 7 * 24 * 60 * 60 * 1000);
    await cols.replayShares.insertOne({ _id: shareId, roomId, accountId, expiresAt, ts: now() });
    return ok({ shareId });
  }

  /** S1-RP：通过 shareId 读取录像（无需登录，TTL 到期自动失效）。 */
  async getReplayByShare(req: FastifyRequest, reply: FastifyReply) {
    const { shareId } = req.params as { shareId: string };
    const { cols, now: _now } = this.deps;
    const share = await cols.replayShares.findOne({ _id: shareId });
    if (!share) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'share not found'));
    const blob = await cols.replayBlobs.findOne({ _id: share.roomId });
    if (!blob) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'replay not found'));
    return ok({ replay: blob.replay });
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

  /**
   * 单位养成合成（S12，ECONOMY_NUMBERS §4.1）：服务器权威校验库存 → 消耗 5 张 N 级卡 → +1 张
   * (N+1) → 重算 unitLevels → 回推（仅在线）。卡片库存/等级是服务器权威段，putSave 不接受（§8.3）。
   */
  async pveMerge(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { unitId, level } = req.body as { unitId: string; level: number };

    const out = await this.mutateSave(accountId, (s) => {
      const merged = applyCardMerge(s.cardInventory ?? {}, unitId, level);
      if (typeof merged === 'string') return merged; // INVALID_UNIT / INVALID_LEVEL / INSUFFICIENT
      return { ...s, cardInventory: merged, unitLevels: deriveUnitLevels(merged) };
    });
    if ('error' in out) {
      if (out.error === 'INSUFFICIENT') {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough cards'));
      }
      if (out.error === 'INVALID_UNIT' || out.error === 'INVALID_LEVEL') {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, out.error));
      }
      return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
    }
    return ok({ save: out.save });
  }

  // ── 成就（S9，ACHIEVEMENT_DESIGN）：统计里程碑 → 一次性金币。计数只在 PvE/PvP 权威结算点写
  //    （S9-3/S9-6），此处只提供「读定义+进度」与「领取发币」。──────────────────────────
  /** 成就定义表 + 我的 stats + 已领进度（客户端本地算阶，§4.1/§6）。 */
  async getAchievements(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const save = await getOrCreateSave(this.deps.cols, accountId, this.deps.now());
    return ok({
      defs: ACHIEVEMENTS,
      stats: save.stats ?? {},
      achievements: save.achievements ?? {},
    });
  }

  /**
   * 领取某成就某阶金币（§4.3）：服务器二次校验 stat≥阈值 + 未领 → 原子记 claimedTiers（幂等守卫）
   * → commercial 发币（确定性 orderId 防重复发）→ 钱包镜像回推。
   * 先记阶（唯一获胜者）再发币：并发双击只有一个记成功并发币，另一个见已领即拒；崩溃窗口（已记未发）
   * 靠确定性 orderId 可后续补发，金额小一次性可接受。
   */
  async claimAchievement(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { achId, tier } = req.body as { achId: string; tier: number };
    if (!findAchievement(achId)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown achievement'));
    }

    // 原子记阶：校验 + $addToSet 等价（transform 内判已领/未达）。成功 = 本调用是唯一获胜者。
    const recorded = await this.mutateSave(accountId, (s) => {
      const claimed = s.achievements?.[achId]?.claimedTiers ?? [];
      const v = validateClaim(achId, tier, s.stats, claimed);
      if (!v.ok) return v.error; // NOT_REACHED / ALREADY_CLAIMED / BAD_REQUEST
      return {
        ...s,
        achievements: {
          ...s.achievements,
          [achId]: { claimedTiers: [...claimed, tier] },
        },
      };
    });
    if ('error' in recorded) {
      if (recorded.error === 'NOT_REACHED') {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'threshold not reached'));
      }
      if (recorded.error === 'ALREADY_CLAIMED') {
        return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'tier already claimed'));
      }
      if (recorded.error === 'BAD_REQUEST') {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid tier'));
      }
      return reply.code(409).send(err(ErrorCode.REV_CONFLICT, recorded.error));
    }

    // 阶已落库 → 发币（确定性 orderId 幂等）+ 钱包镜像。金额取定义（已被校验过的阶）。
    const def = findAchievement(achId)!;
    const coins = def.tiers[tier - 1]?.coins ?? 0;
    const { cols, commercial, now } = this.deps;
    const orderId = `ach:${accountId}:${achId}:${tier}`;
    const g = await commercial.grant({ accountId, amount: coins, reason: 'achievement', orderId });
    if (!g.ok) {
      // 阶已记但发币失败：返回当前存档（阶已领），granted=0；orderId 确定性可补发。
      return ok({ save: recorded.save, granted: 0 });
    }
    const save = await mirrorCoins(cols, accountId, g.coinsAfter, now());

    // 顶阶达成且该成就有绑定称号 → 授予（幂等，best-effort）
    if (tier === def.tiers.length && def.titleId) {
      await grantTitleToPlayer(cols, accountId, def.titleId, now()).catch(() => {/* ignore */});
    }

    return ok({ save, granted: coins });
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
      case 'NOT_FRIEND':
        return reply.code(403).send(err(ErrorCode.NOT_FRIEND, 'not friends'));
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

  /** 离线红点聚合（SOC8）：登录后一次性拉总未读红点（申请 / 会话 / 邮件）。 */
  async getSocialBadges(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const badges = await socialBadges(this.deps.cols, accountId, this.deps.now());
    return ok(badges);
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

  // ── 社交：私聊（S6-2）。发送走 REST（单一写者）；收消息经 gateway chat_message push。──
  async getConversations(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const conversations = await getConversations(this.deps.cols, accountId);
    return ok({ conversations });
  }

  async getMessages(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { convId } = req.params as { convId: string };
    const q = req.query as { before?: string | number; limit?: string | number };
    const before = q.before !== undefined ? Number(q.before) : undefined;
    const limit = q.limit !== undefined ? Number(q.limit) : 30;
    const messages = await getMessages(this.deps.cols, accountId, convId, before, limit);
    if (messages === null) {
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'conversation not found'));
    }
    return ok({ messages });
  }

  async sendChat(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { toPublicId, body } = req.body as { toPublicId: string; body: string };
    if (!this.allowChat(accountId, this.deps.now())) {
      return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many messages'));
    }
    // 敏感词地区：按发送方账号 region 选词表（SOC10）。auth 时由 Accept-Language 惰性打标，
    // 缺省 / 旧账号 → 'global'（仅基础词表）。单条 body 只存一份，发送端过滤最自然。
    const region = await getRegion(this.deps.cols, accountId);
    const res = await sendMessage(this.deps.cols, accountId, toPublicId, body, region, this.deps.now());
    if (res.kind === 'error') return this.sendSocialError(reply, res.error);
    // 推送给收件方（在线则弹消息 / 红点）。
    void this.deps.gateway.push(res.to, {
      kind: 'chat_message',
      convId: res.convId,
      fromPublicId: res.fromProfile.publicId,
      fromName: res.fromProfile.displayName,
      body: res.body,
      ts: res.ts,
    });
    return ok({ messageId: res.messageId, ts: res.ts });
  }

  async readChat(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { convId } = req.body as { convId: string };
    await markConversationRead(this.deps.cols, accountId, convId);
    return ok({ ok: true });
  }

  // ── 社交：邮件（S6-3）。附件领取经 commercial 发金币 + meta 发 inventory，claimOrderId 幂等。──
  async getMail(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { mail, unread } = await getMail(this.deps.cols, accountId, this.deps.now());
    return ok({ mail, unread });
  }

  async readMail(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: string };
    const okRead = await readMail(this.deps.cols, accountId, id, this.deps.now());
    if (!okRead) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'mail not found'));
    return ok({ ok: true });
  }

  async deleteMail(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: string };
    await deleteMail(this.deps.cols, accountId, id);
    return ok({ ok: true });
  }

  async claimMail(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: string };
    const { cols, commercial, now } = this.deps;

    // 先看附件构成：含金币时需 commercial 可用（否则无法发币）→ 在领取前判，避免标记后无法发放。
    const peek = await cols.mail.findOne({ _id: id, to: accountId });
    if (!peek) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'mail not found'));
    if (!peek.attachments || peek.attachments.length === 0) {
      return reply.code(400).send(err(ErrorCode.NO_ATTACHMENT, 'no attachment'));
    }
    if (peek.claimedAt !== undefined) {
      return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'already claimed'));
    }
    const split = splitAttachments(peek.attachments);
    if (split.coins > 0 && !commercial.available) {
      return reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'commercial service unavailable'));
    }

    const orderId = randomUUID();
    const claimed = await claimMailAtomic(cols, accountId, id, orderId, now());
    if ('error' in claimed) {
      if (claimed.error === 'ALREADY_CLAIMED') {
        return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'already claimed'));
      }
      if (claimed.error === 'NO_ATTACHMENT') {
        return reply.code(400).send(err(ErrorCode.NO_ATTACHMENT, 'no attachment'));
      }
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'mail not found'));
    }

    // 发金币（commercial 权威，orderId 幂等）→ 取回权威余额做镜像；无金币则镜像不动。
    let coinsAfter: number | null = null;
    if (split.coins > 0) {
      const g = await commercial.grant({ accountId, amount: split.coins, reason: 'mail', orderId });
      if (g.ok) coinsAfter = g.coinsAfter;
    }
    // 发 inventory（皮肤幂等 set / 物品 $inc）+ 钱包镜像 + deliveredOrders 幂等账本。
    const cur = await getOrCreateSave(cols, accountId, now());
    const newSkins = split.skins.filter((s) => !cur.inventory.skins.includes(s));
    const save = await deliverMailGrant(cols, accountId, orderId, newSkins, split.items, coinsAfter, now(), split.materials);
    return ok({ save });
  }

  async sendMail(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { toPublicId, subject, body } = req.body as {
      toPublicId: string;
      subject: string;
      body: string;
    };
    const fromProfile = await profileOf(this.deps.cols, accountId);
    if (!fromProfile) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'sender profile missing'));
    const res = await sendPlayerMail(
      this.deps.cols,
      accountId,
      fromProfile,
      toPublicId,
      subject,
      body,
      this.deps.now(),
    );
    if (res.kind === 'error') {
      if (res.error === 'NOT_FRIEND') {
        return reply.code(403).send(err(ErrorCode.NOT_FRIEND, 'not friends'));
      }
      if (res.error === 'NOT_FOUND') {
        return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'player not found'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'bad request'));
    }
    void this.deps.gateway.push(res.to, { kind: 'mail_new', mailId: res.mailId, hasAttachment: false });
    return ok({ mailId: res.mailId });
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
    // 发货按池分流（独立单位卡池，S12-C）：
    //  • 单位卡池 → results.itemId 是 cardKey，入 cardInventory + 重算 unitLevels（不走 dupe 退币，
    //    集卡天然重复全部入库；duplicate 恒 false 仅作展示）。
    //  • 皮肤池 → 新皮肤进 inventory.skins（幂等），重复转化 S5 暂缓（见 economy.ts 注释）。
    await getOrCreateSave(cols, accountId, now());
    if (poolId === UNIT_CARD_POOL_ID) {
      const cardGrants: Record<string, number> = {};
      for (const r of draw.results) cardGrants[r.itemId] = (cardGrants[r.itemId] ?? 0) + 1;
      const save = await deliverCardGrant(
        cols,
        accountId,
        orderId,
        cardGrants,
        draw.coinsAfter,
        { [poolId]: draw.pityAfter },
        now(),
      );
      await commercial.orderDelivered({ orderId });
      const marked = draw.results.map((r) => ({
        itemId: r.itemId,
        rarity: r.rarity,
        duplicate: false,
      }));
      return ok({ save, results: marked });
    }
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
    const { adToken, platform } = req.body as { adToken: string; platform?: string };
    if (!adToken) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing adToken'));

    const { cols, commercial, now } = this.deps;
    const ts = now();
    const dayKey = adsDayKey(ts);

    // 30min 间隔门（C2）。
    const intervalOk = await checkAdInterval(cols, accountId, dayKey, ts, ADS_MIN_INTERVAL_MS);
    if (!intervalOk) {
      return reply.code(429).send(err(ErrorCode.DAILY_CAP_REACHED, 'ad cooldown not elapsed'));
    }

    // 日 cap（C2）。
    const allowed = await bumpAdsCap(cols, accountId, dayKey, ADS_DAILY_CAP, ts);
    if (!allowed) {
      return reply.code(429).send(err(ErrorCode.DAILY_CAP_REACHED, 'daily ad cap reached'));
    }

    // 凭证唯一性（C2）：hash 落库，重放拒绝。
    const tokenHash = hashAdToken(adToken);
    const unique = await recordAdToken(cols, tokenHash, accountId, ts);
    if (!unique) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'duplicate adToken'));
    }

    // 平台验签（C2）：非 dev 时验。
    const plat = platform ?? 'dev';
    if (plat !== 'dev') {
      const sigOk = verifyAdPlatformToken(plat, adToken);
      if (!sigOk) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid ad signature'));
    }

    const credit = await commercial.adsCredit({ accountId, amount: ADS_REWARD_COINS, dayKey });
    if (!credit.ok) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, credit.error));
    const save = await mirrorCoins(cols, accountId, credit.coinsAfter, ts);
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

  /**
   * 装备合成（E2，EQUIPMENT_DESIGN §4/§7）：扣文具材料 → roll 一件 +0 基础装备 → 入库（300 上限）。
   * idempotencyKey 幂等（客户端生成）：重放返回首次结果，不二次扣料、不二次 roll。
   */
  async craftEquipment(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { defId, idempotencyKey } = req.body as { defId: string; idempotencyKey: string };
    const { cols, now } = this.deps;
    const r = await craftEquipment(cols, now, accountId, defId, idempotencyKey);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
    return ok({ save: r.save, instance: r.instance });
  }

  /**
   * 装备强化（E3，EQUIPMENT_DESIGN §6）：服务器掷骰（成功率表）→ 扣材料 + 金币（commercial 权威）→
   * 成功 level+1，失败不掉级。idempotencyKey 幂等（掷骰/扣料绑定 key，重放返回首次结果）。
   */
  async enhanceEquipment(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { instanceId, idempotencyKey, useProtect } = req.body as { instanceId: string; idempotencyKey: string; useProtect?: boolean };
    const { cols, commercial, now } = this.deps;
    const r = await enhanceEquipment(cols, commercial, now, accountId, instanceId, idempotencyKey, useProtect === true);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
    return ok({ success: r.success, instance: r.instance, save: r.save });
  }

  /**
   * 装备分解（E3，EQUIPMENT_DESIGN §6.3）：+0~4 件返 70% 打造材料、移出库存；+5 拒、穿戴/锁定拒。
   * 批量 + idempotencyKey 幂等（重放返回首次返还）。
   */
  async salvageEquipment(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { instanceIds, idempotencyKey } = req.body as { instanceIds: string[]; idempotencyKey: string };
    const { cols, now } = this.deps;
    const r = await salvageEquipment(cols, now, accountId, instanceIds, idempotencyKey);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
    return ok({ refunded: r.refunded, save: r.save });
  }

  /**
   * 装备穿戴 / 卸下（E4，EQUIPMENT_DESIGN §3.4）：校验槽位匹配 → 写 gear.global[slot]（或 byUnit）。
   * instanceId=null 卸下。纯状态、无 idem（天然幂等）。
   */
  async equipEquipment(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { slot, instanceId, unitType } = req.body as {
      slot: string;
      instanceId: string | null;
      unitType?: string;
    };
    const { cols, now } = this.deps;
    const r = await equipEquipment(cols, now, accountId, slot, instanceId ?? null, unitType);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
    return ok({ save: r.save });
  }

  /**
   * 装备洗练（E6，EQUIPMENT_DESIGN §7.8）：消耗同槽低档素材件，保留主词条，重 roll 副词条。
   * fine/rare/epic 可洗练；素材须同槽且恰低一档。idempotencyKey 幂等。
   */
  async reforgeEquipment(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { targetId, materialId, idempotencyKey } = req.body as {
      targetId: string;
      materialId: string;
      idempotencyKey: string;
    };
    const { cols, now } = this.deps;
    const r = await reforgeEquipment(cols, now, accountId, targetId, materialId, idempotencyKey);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
    return ok({ instance: r.instance, save: r.save });
  }

  // ── S11 排行榜 / 战令 ──────────────────────────────────────────────────────

  /** Top-100 天梯排行榜（当前赛季 ELO 降序，S11 §5）。 */
  async getLeaderboard(req: FastifyRequest) {
    const { cols, now } = this.deps;
    const season = await getCurrentSeason(cols, now());
    const top = await cols.saves
      .find({ 'save.pvp.seasonNo': season.seasonNo })
      .sort({ 'save.pvp.elo': -1 })
      .limit(100)
      .project({ _id: 1, 'save.pvp': 1, 'save.equipped': 1 })
      .toArray();
    const accountIds = top.map((d) => d._id);
    const accounts = await cols.accounts
      .find({ _id: { $in: accountIds } }, { projection: { _id: 1, displayName: 1, publicId: 1 } })
      .toArray();
    const byId = new Map(accounts.map((a) => [a._id, a]));
    const entries = top.map((d, i) => {
      const a = byId.get(d._id);
      const pvp = (d as unknown as { save: { pvp: { elo: number; rank: string }; equipped?: Record<string, string> } }).save.pvp;
      const equipped = (d as unknown as { save: { equipped?: Record<string, string> } }).save.equipped;
      const equippedTitle = equipped?.['title'];
      return {
        rank: i + 1,
        displayName: a?.displayName ?? '',
        publicId: a?.publicId ?? '',
        elo: pvp.elo,
        pvpRank: pvp.rank,
        ...(equippedTitle ? { equippedTitle } : {}),
      };
    });
    return ok({ seasonNo: season.seasonNo, entries });
  }

  /** 购买当前赛季战令（600 金币，S11 §9）。 */
  async buyBattlePass(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { cols, commercial, now } = this.deps;

    // 先确认/创建战令数据（惰性创建：本季首次购买时初始化）。
    const save = await getOrCreateSave(cols, accountId, now());
    const currentSeason = await getCurrentSeason(cols, now());
    let bp = save.battlePass?.seasonNo === currentSeason.seasonNo
      ? save.battlePass
      : makeFreshBattlePass(currentSeason.seasonNo);
    if (bp.hasPass) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'battle pass already purchased'));
    }

    const orderId = randomUUID();
    const charge = await commercial.spend({ accountId, amount: BATTLEPASS_BUY_COST, reason: 'battlepass', orderId });
    if (!charge.ok) {
      if (charge.error === 'INSUFFICIENT_FUNDS') {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, charge.error));
    }

    // 原子写 hasPass=true（乐观锁）。
    const out = await this.mutateSave(accountId, (s) => {
      const curBp = s.battlePass?.seasonNo === currentSeason.seasonNo
        ? s.battlePass
        : makeFreshBattlePass(currentSeason.seasonNo);
      if (curBp.hasPass) return 'ALREADY_PURCHASED';
      return { ...s, battlePass: { ...curBp, hasPass: true } };
    });
    if ('error' in out) {
      if (out.error === 'ALREADY_PURCHASED') {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'battle pass already purchased'));
      }
      return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
    }
    bp = out.save.battlePass!;
    const finalSave = await mirrorCoins(cols, accountId, charge.coinsAfter, now());
    return ok({ battlePass: { ...bp, ...finalSave.battlePass } });
  }

  /** 领取战令奖励（免费轨 or 付费轨，S11 §9）。 */
  async claimBattlePass(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { track, level } = req.body as { track: 'free' | 'paid'; level: number };
    const { cols, commercial, now } = this.deps;

    // 原子校验 + 记领取（乐观锁防双击）。
    let claimedReward: { kind: string; count: number } | null = null;
    const out = await this.mutateSave(accountId, (s) => {
      const bp = s.battlePass;
      if (!bp) return 'NO_BATTLEPASS';
      const r = claimBpReward(bp, track, level);
      if (!r.ok) return r.error;
      claimedReward = r.reward;
      return { ...s, battlePass: r.bp };
    });
    if ('error' in out) {
      switch (out.error) {
        case 'NO_BATTLEPASS':
        case 'BAD_REQUEST':
          return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'bad request'));
        case 'NOT_REACHED':
          return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'level not reached'));
        case 'PASS_REQUIRED':
          return reply.code(403).send(err(ErrorCode.NOT_FOUND, 'battle pass not purchased'));
        case 'ALREADY_CLAIMED':
          return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'already claimed'));
        default:
          return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
      }
    }
    const reward = claimedReward!;
    let finalSave = out.save;
    // 若奖励含金币，经 commercial 发放后镜像钱包。
    if (reward.kind === 'coins' && reward.count > 0 && commercial.available) {
      try {
        const orderId = `bp.claim.${accountId}.${track}.${level}`;
        const g = await commercial.grant({ accountId, amount: reward.count, reason: 'battlepass_claim', orderId });
        if (g.ok) finalSave = await mirrorCoins(cols, accountId, g.coinsAfter, now());
      } catch (e) {
        req.log.warn({ err: e }, 'battlepass claim coin grant failed (coins may be delayed)');
      }
    }
    return ok({ battlePass: finalSave.battlePass!, reward });
  }
}
