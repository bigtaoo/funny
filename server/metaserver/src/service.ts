// metaserver serviceHandlers：openapi.yml 的 operationId → 方法（fastify-openapi-glue 装配）。
// 校验/路由由 glue 按 spec 完成；此处只做业务。S0 实现 auth + save；
// 经济/盲盒/IAP（S2/S4）先返回 NOT_IMPLEMENTED 占位，契约已就绪。
import { randomUUID, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collections, JwtConfig, SyncPatch, SaveData, FeatureFlagCache, FlagContext, FlagPlatform } from '@nw/shared';
import { ErrorCode, ERROR_HTTP_STATUS, err, ok, signToken, FLAG_KEYS, flagDefault, extractBearer, verifyToken, FLAG_PLATFORMS } from '@nw/shared';
import { buildLokiPayload, buildAnomalyLokiPayload, pushToLoki, type ClientLogEntry, type ClientAnomalyEvent } from './clientLog.js';
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
  accrueRetentionTask,
  claimCheckinDay,
  claimDailyReward as calcDailyReward,
  CHECKIN_REWARDS,
  DAILY_TASKS,
  DAILY_POINTS_THRESHOLD,
  DAILY_COINS_REWARD,
  resetStaleRetention,
  nextCheckinDay,
  dailyRewardClaimable,
  isDailyTaskDone,
  makeDayKey,
  makeMonthKey,
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
import { parseTitleId } from '@nw/shared';
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
import { profileOf } from './social.js';
import { splitAttachments, insertSystemMail } from './mail.js';
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
import {
  getEventsForAccount,
  accrueEventTask,
  claimEventReward,
} from './events.js';

export interface ServiceDeps {
  cols: Collections;
  jwt: JwtConfig;
  now: () => number;
  commercial: CommercialClient;
  /** gateway 公开 WS 地址，随 auth/save 回包下发；null = 不下发（客户端退回自身配置）。 */
  gatewayPublicUrl: string | null;
  /** gateway 内部客户端：PvE L1 录像抽检经 /gw/judge 派第三方无头复算。未配置则不抽检（直接发材料）。 */
  gateway: GatewayClient;
  /** 每 IP 15 分钟内最大 auth 尝试数。0 = 禁用（测试/CI 用）。 */
  authRateLimit: number;
  /** feature flag 缓存（公开 /bootstrap 求值；FEATURE_FLAGS_DESIGN §9.3）。null = 无 flag 源，bootstrap 恒空 map。 */
  flags: FeatureFlagCache | null;
  /** 部署区域（注入 flag 求值 ctx）。 */
  region: string | null;
  /** Loki push 地址（POST /client/log 转发客户端日志；null = 静默丢弃）。 */
  lokiPushUrl: string | null;
  /** socialsvc 内部客户端（P2）：好友/私聊/邮件路由代理 + 邮件原子领取。null = 路由仍由 metaserver 自身处理。 */
  socialsvc: import('./socialsvcClient.js').MetaSocialsvcClient | null;
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

/**
 * 状态流分享 blob 体量上限。blob 是客户端 gzip+base64 后的**压缩串**（§7），压缩比 ~10-20×，故
 * 2MB 压缩串足以容纳一局很长的对局；超限拒绝（提示这局太长）。Fastify bodyLimit 另设 ≥ 此值
 * （见 app.ts），令本处优雅 400 先于 Fastify 413 触发。
 */
const STATE_REPLAY_MAX_BYTES = 2 * 1024 * 1024;
/** 状态流分享过期天数（先定 14 天；永久 vs N 天上线期再定，§7）。 */
const STATE_REPLAY_EXPIRE_DAYS = 14;
/** 每账号铸码限流：每小时上限。 */
const STATE_REPLAY_SHARE_PER_HOUR = 20;

export class MetaService {
  private readonly oauth = createOAuthService();
  private readonly authRate: { allow(key: string, now: number): boolean };
  /** 异常事件「全量」上报按 IP 限流：每 IP 60s 最多 30 次 POST /client/anomaly（挡刷 Loki）。进程内近似。 */
  private readonly anomalyRate = new SlidingRateLimiter(30, 60 * 1000);

  constructor(private readonly deps: ServiceDeps) {
    this.authRate = deps.authRateLimit > 0
      ? new SlidingRateLimiter(deps.authRateLimit, 15 * 60 * 1000)
      : { allow: () => true };
  }

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
   * 登录/注册 IP 限流（S4-3）：每 IP 15 分钟内最多 authRateLimit 次 auth 尝试（阻止暴力撞库）。
   * 进程内近似（横扩时是 per-instance，足以抵御单机撞库；精确全局限流待 Redis）。
   * authRateLimit=0 时禁用（CI/测试用）。
   */
  private allowAuthAttempt(req: FastifyRequest, now: number): boolean {
    const ip = req.ip ?? 'unknown';
    return this.authRate.allow(ip, now);
  }

  /**
   * 状态流铸码限流（REPLAY_SHARE_DESIGN §3.1）：每账号近 1 小时铸码次数滑窗。进程内近似
   * （meta 横扩时 per-instance，足以挡刷屏）。返回 true=允许并记一次。
   */
  private readonly stateShareRate = new Map<string, number[]>();
  private allowStateShare(accountId: string, now: number): boolean {
    const win = this.stateShareRate.get(accountId)?.filter((t) => now - t < 3_600_000) ?? [];
    if (win.length >= STATE_REPLAY_SHARE_PER_HOUR) {
      this.stateShareRate.set(accountId, win);
      return false;
    }
    win.push(now);
    this.stateShareRate.set(accountId, win);
    return true;
  }

  /** gateway 公开 WS 地址（配置了才下发）。客户端据此连控制面，无需自身硬编码 gateway 地址。 */
  private get gatewayField(): { gatewayUrl?: string } {
    return this.deps.gatewayPublicUrl ? { gatewayUrl: this.deps.gatewayPublicUrl } : {};
  }

  // ── auth ──────────────────────────────────────────

  /** C4/C5-b：检查账号级封号 / 软删除标记；命中则 reject 并返回 true。 */
  private async rejectIfBanned(cols: typeof this.deps.cols, accountId: string, reply: FastifyReply): Promise<boolean> {
    const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { flags: 1, deletedAt: 1 } });
    if (doc?.deletedAt) {
      void reply.code(410).send(err(ErrorCode.ACCOUNT_DELETED, 'account deleted'));
      return true;
    }
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
   * C5-b 账号软删除（Apple 5.1.1(v) 要求）。
   * 写 accounts.deletedAt；后续 auth 返 ACCOUNT_DELETED（410）。
   * 7 天宽限期后异步清理由 admin/cron 触发（本期仅标记）。
   */
  async deleteAccount(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { cols, now } = this.deps;
    const confirmToken = randomUUID();
    await cols.accounts.updateOne({ _id: accountId }, { $set: { deletedAt: now() } });
    return ok({ confirmToken });
  }

  /** C5-c GDPR 同意记录：设 accounts.flags.gdprConsent=true。 */
  async recordGdprConsent(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { consent } = req.body as { consent: boolean };
    const { cols } = this.deps;
    await cols.accounts.updateOne(
      { _id: accountId },
      { $set: { 'flags.gdprConsent': consent } },
    );
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
    // 体力快照注入（A4）：stamina 存于独立集合，回传时合并进 save 镜像。
    const stamina = await this.readStaminaSnapshot(accountId, now());
    save = { ...save, stamina };
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

  // ── 体力系统（A4）──────────────────────────────────────────────────────────

  private static readonly STAMINA_CAP = 120;
  private static readonly STAMINA_REGEN_MS = 6 * 60 * 1000; // 6 min per point

  /**
   * 原子扣体力：读 pveStamina → 应用自然回复 → $inc 检查余额。
   * 返回 { ok: true, current } 或 { ok: false }（余额不足）。
   */
  private async deductStamina(
    accountId: string,
    cost: number,
    now: number,
  ): Promise<{ ok: true; current: number; regenAt: number } | { ok: false }> {
    const { cols } = this.deps;
    const CAP = MetaService.STAMINA_CAP;
    const REGEN_MS = MetaService.STAMINA_REGEN_MS;

    // 懒建文档（新账号首次进关）。
    await cols.pveStamina.updateOne(
      { _id: accountId },
      { $setOnInsert: { _id: accountId, current: CAP, regenAt: 0 } },
      { upsert: true },
    );

    // 先应用自然回复（两步：读→算→写；允许极小并发窗口多发 1 点，概率极低且对玩家友好）。
    const stDoc = await cols.pveStamina.findOne({ _id: accountId });
    if (!stDoc) return { ok: false }; // 理论不可达（upsert 已建）

    let { current, regenAt } = stDoc;
    if (current < CAP && regenAt > 0 && now >= regenAt) {
      const ticks = Math.floor((now - regenAt) / REGEN_MS) + 1;
      current = Math.min(CAP, current + ticks);
      regenAt = current >= CAP ? 0 : regenAt + ticks * REGEN_MS;
      await cols.pveStamina.updateOne({ _id: accountId }, { $set: { current, regenAt } });
    }

    if (current < cost) return { ok: false };

    // 原子扣除（$inc 带 $gte 守卫防并发超扣）。
    const newCurrent = current - cost;
    // 回复计时：若扣后从满降到 < 满，开始计时；若已在计时，维持 regenAt 不变。
    const newRegenAt =
      regenAt !== 0
        ? regenAt
        : newCurrent < CAP
          ? now + REGEN_MS
          : 0;
    const res = await cols.pveStamina.findOneAndUpdate(
      { _id: accountId, current: { $gte: cost } },
      { $inc: { current: -cost }, $set: { regenAt: newRegenAt } },
      { returnDocument: 'after' },
    );
    if (!res) return { ok: false }; // 并发竞争失败
    return { ok: true, current: res.current, regenAt: res.regenAt };
  }

  /** 读取当前体力（含自然回复计算），用于回传 SaveData.stamina 快照。 */
  private async readStaminaSnapshot(
    accountId: string,
    now: number,
  ): Promise<{ current: number; regenAt: number }> {
    const { cols } = this.deps;
    const CAP = MetaService.STAMINA_CAP;
    const REGEN_MS = MetaService.STAMINA_REGEN_MS;
    const doc = await cols.pveStamina.findOne({ _id: accountId });
    if (!doc) return { current: CAP, regenAt: 0 };
    let { current, regenAt } = doc;
    if (current < CAP && regenAt > 0 && now >= regenAt) {
      const ticks = Math.floor((now - regenAt) / REGEN_MS) + 1;
      current = Math.min(CAP, current + ticks);
      regenAt = current >= CAP ? 0 : regenAt + ticks * REGEN_MS;
    }
    return { current, regenAt };
  }

  /** 补体力（走 commercial 扣金币；60 体力 = 30 金币，§A4）。 */
  async purchaseStamina(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { commercial, now: nowFn } = this.deps;
    const now = nowFn();
    const CAP = MetaService.STAMINA_CAP;
    const REGEN_MS = MetaService.STAMINA_REGEN_MS;
    const { amount } = req.body as { amount: number };
    if (amount !== 60) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'amount must be 60'));
    }
    const COST_COINS = 30;
    const orderId = randomUUID();
    const spendRes = await commercial.spend({ accountId, amount: COST_COINS, reason: 'stamina_purchase', orderId });
    if (!spendRes.ok) {
      return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
    }
    // 添加体力（最多补到 CAP，多余体力丢弃）。
    const { cols } = this.deps;
    await cols.pveStamina.updateOne(
      { _id: accountId },
      { $setOnInsert: { _id: accountId, current: CAP, regenAt: 0 } },
      { upsert: true },
    );
    const stDoc = await cols.pveStamina.findOne({ _id: accountId });
    const curCurrent = stDoc?.current ?? CAP;
    const newCurrent = Math.min(CAP, curCurrent + amount);
    const newRegenAt = newCurrent >= CAP ? 0 : (stDoc?.regenAt ?? 0) !== 0 ? (stDoc?.regenAt ?? 0) : now + REGEN_MS;
    await cols.pveStamina.updateOne({ _id: accountId }, { $set: { current: newCurrent, regenAt: newRegenAt } });
    return ok({ stamina: { current: newCurrent, regenAt: newRegenAt } });
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

  /** B5：幂等打点某每日任务（今日已打过则 no-op，不抛错）。fire-and-forget 调用方忽略失败。 */
  private async bumpRetentionTask(accountId: string, taskId: import('@nw/shared').DailyTaskId): Promise<void> {
    const tsMs = this.deps.now();
    await this.mutateSave(accountId, (s) => {
      const next = accrueRetentionTask(s.retention, taskId, tsMs);
      if (next === s.retention) return s; // 今日已打过，no-op
      return { ...s, retention: next };
    }).catch(() => {/* 留存打点失败不影响主流程 */});
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

    // 体力扣除（A4）：先扣再结算，防止先结算再被拒。
    const staminaCost = level.staminaCost ?? 1;
    const staminaResult = await this.deductStamina(accountId, staminaCost, now());
    if (!staminaResult.ok) {
      return reply.code(402).send(err(ErrorCode.INSUFFICIENT_STAMINA, 'not enough stamina'));
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
          // S9-3b：存客户端上报计数作审计比对基准（verdict.statsJson 是权威来源，报告仅供 ops 可视）。
          ...(clientStats ? { reportedStats: clientStats } : {}),
          ts: now(),
        });
        const saveWithSt = { ...prog.save, stamina: { current: staminaResult.current, regenAt: staminaResult.regenAt } };
        return ok({
          save: saveWithSt,
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
    // B5：每日任务「通关 PvE」打点（幂等，今日已打过则 no-op）。
    await this.bumpRetentionTask(accountId, 'pve.clear');
    // B6：活动任务「pve.clear」打点（best-effort）。
    accrueEventTask(cols, accountId, 'pve.clear', now()).catch(() => {});
    // 将 retention 更新合入返回的 save，确保客户端 adoptServer 后立即看到任务完成状态。
    const nextRetention = accrueRetentionTask(granted.save.retention, 'pve.clear', now());
    const saveWithSt = {
      ...granted.save,
      ...(nextRetention !== granted.save.retention ? { retention: nextRetention } : {}),
      stamina: { current: staminaResult.current, regenAt: staminaResult.regenAt },
    };
    return ok({
      save: saveWithSt,
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

  /**
   * 状态流录像游戏外分享 — 铸码（REPLAY_SHARE_DESIGN §3.1）。分享者本人已登录；客户端自产的
   * 状态流 blob 随请求上传。服务端**不碰引擎、不碰数值表**，只做带访问控制的对象存储：校验体量
   * 上限 + 每账号限流 → 写库 → 返回不可猜 shareCode。状态流**不可信**，绝不进反作弊/结算。
   */
  async createStateReplayShare(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols, now } = this.deps;
    const ts = now();

    if (!this.allowStateShare(accountId, ts)) {
      return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many shares, try later'));
    }

    // blob = 客户端 gzip+base64 后的压缩串（opaque，服务端不解压、不解释，§7）。
    const blob = (req.body as { blob?: unknown }).blob;
    if (typeof blob !== 'string' || blob.length === 0) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing replay blob'));
    }
    const sizeBytes = Buffer.byteLength(blob);
    if (sizeBytes > STATE_REPLAY_MAX_BYTES) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'replay too large'));
    }

    // 不可猜随机串（144bit base64url）防枚举。
    const shareCode = randomBytes(18).toString('base64url');
    const expireAt = new Date(ts + STATE_REPLAY_EXPIRE_DAYS * 24 * 60 * 60 * 1000);
    await cols.stateReplayShares.insertOne({
      _id: shareCode,
      blob,
      createdBy: accountId,
      createdAt: ts,
      expireAt,
      viewCount: 0,
      sizeBytes,
    });
    return ok({ shareCode });
  }

  /**
   * 状态流录像 — 公开取（REPLAY_SHARE_DESIGN §3.2）。**无需登录**；取 blob 回传 + viewCount++；
   * 不存在/过期 → 404（客户端落地页带「试玩」CTA）。
   */
  async getStateReplayShare(req: FastifyRequest, reply: FastifyReply) {
    const { shareCode } = req.params as { shareCode: string };
    const { cols } = this.deps;
    const doc = await cols.stateReplayShares.findOne({ _id: shareCode });
    if (!doc) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'share not found'));
    // 浏览计数（不阻塞回包）。
    void cols.stateReplayShares.updateOne({ _id: shareCode }, { $inc: { viewCount: 1 } });
    return ok({ blob: doc.blob });
  }

  // ── F3 公开 bootstrap + 客户端日志定向采集（FEATURE_FLAGS_DESIGN §9）────────────────────
  /** 4 个客户端日志分级 flag（按 verbose 程度排序，仅文档/守卫用）。 */
  private static readonly CLIENT_LOG_KEYS = FLAG_KEYS.filter((k) => k.startsWith('client_log_'));

  /** 从请求里解析 flag 求值上下文：query 的 platform/publicId + 可选 token 的 accountId。 */
  private flagCtx(req: FastifyRequest): FlagContext {
    const q = (req.query ?? {}) as { platform?: unknown; publicId?: unknown };
    const ctx: FlagContext = {};
    if (typeof q.publicId === 'string' && q.publicId) ctx.publicId = q.publicId;
    if (typeof q.platform === 'string' && (FLAG_PLATFORMS as readonly string[]).includes(q.platform)) {
      ctx.platform = q.platform as FlagPlatform;
    }
    if (this.deps.region) ctx.region = this.deps.region;
    // 登录态可选：带 token 则解析 accountId 求值更精确；无 token / 无效 token 静默忽略（bootstrap 匿名可调）。
    const token = extractBearer(req.headers['authorization']);
    if (token) {
      try { ctx.accountId = verifyToken(token, this.deps.jwt); } catch { /* anonymous */ }
    }
    return ctx;
  }

  /**
   * 公开 bootstrap（§9.3）：匿名可调（带 token 则注入 accountId 求值更精确）。对全量白名单逐个求值，
   * **只回与 default 不同的 flag**——绝大多数玩家拿到空 map → 零负担。规则/白名单绝不下发，只给布尔结果。
   * 无 flag 源（未配 admin）→ 恒空 map。
   */
  async bootstrap(req: FastifyRequest) {
    const flags: Record<string, boolean> = {};
    const cache = this.deps.flags;
    if (cache) {
      const ctx = this.flagCtx(req);
      for (const key of FLAG_KEYS) {
        const resolved = cache.isOn(key, ctx);
        if (resolved !== flagDefault(key)) flags[key] = resolved;
      }
    }
    return ok({ flags });
  }

  /** 该 publicId 当前是否被任一 client_log_* flag 的 allowPublicIds 点名（防任意客户端往 Loki 灌日志）。 */
  private isClientLogTargeted(publicId: string): boolean {
    const cache = this.deps.flags;
    if (!cache) return false;
    for (const key of MetaService.CLIENT_LOG_KEYS) {
      if (cache.rawDoc(key)?.rollout?.allowPublicIds?.includes(publicId)) return true;
    }
    return false;
  }

  /**
   * 客户端日志上报 → Loki（§9.4）。**永远回 200**（绝不影响玩家）。防滥用：仅当该 publicId 当前被
   * client_log_* 定向时才转发，否则静默丢弃（非定向客户端 bootstrap 拿空 map、本就不会调本端点，此为兜底）。
   * Loki 不可达亦静默丢弃。
   */
  async clientLog(req: FastifyRequest, reply: FastifyReply) {
    const body = (req.body ?? {}) as { publicId?: unknown; platform?: unknown; logs?: unknown };
    const publicId = typeof body.publicId === 'string' ? body.publicId : '';
    if (!publicId || !Array.isArray(body.logs)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing publicId / logs'));
    }
    // 未被定向 → 接受但丢弃（不 4xx，避免泄露「谁在被采集」）。
    if (!this.isClientLogTargeted(publicId)) return ok({ accepted: 0 });

    const platform = typeof body.platform === 'string' ? body.platform : undefined;
    // 兜底上限：最多 1000 条、每条 msg 截断 2000 字符（Fastify bodyLimit 已挡超大 body）。
    const entries: ClientLogEntry[] = (body.logs as unknown[]).slice(0, 1000).flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const o = raw as Record<string, unknown>;
      const msg = typeof o.msg === 'string' ? o.msg.slice(0, 2000) : '';
      if (!msg) return [];
      const e: ClientLogEntry = {
        level: typeof o.level === 'string' ? o.level : 'info',
        msg,
        ts: typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : this.deps.now(),
      };
      if (typeof o.tag === 'string' && o.tag) e.tag = o.tag.slice(0, 64);
      return [e];
    });

    const payload = buildLokiPayload(publicId, entries, platform, () =>
      (BigInt(this.deps.now()) * 1_000_000n).toString(),
    );
    if (payload) {
      // fire-and-forget：不阻塞回包，失败静默（onError 仅调试期需要时挂）。
      void pushToLoki(this.deps.lokiPushUrl, payload);
    }
    return ok({ accepted: entries.length });
  }

  /**
   * 客户端异常事件「全量」上报 → Loki（与定向采集互补，**不受 allowPublicIds 约束**：任何客户端的
   * 内存超标 / CPU 持续饱和 / WebGL 丢失 / 卡死 / 未捕获异常 / 上次崩溃都直报，便于全网定位野外异常）。
   * 防滥用：按 IP 60s/30 次限流（超限静默丢弃，仍回 200，绝不影响玩家）；最多取前 200 条、各字段截断。
   * **永远回 200**（Loki 不可达 / 限流 / 无效亦不影响玩家）。
   */
  async clientAnomaly(req: FastifyRequest, reply: FastifyReply) {
    const body = (req.body ?? {}) as { publicId?: unknown; platform?: unknown; events?: unknown };
    if (!Array.isArray(body.events)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing events'));
    }
    // IP 限流：超限即静默丢弃（不 4xx，避免客户端据此重试 / 摸出限流阈值）。
    if (!this.anomalyRate.allow(req.ip ?? 'unknown', this.deps.now())) return ok({ accepted: 0 });

    // publicId 可选（异常可发生在登录前）；缺省归 'anon'，仍上报以便统计无主异常。
    const publicId = typeof body.publicId === 'string' && body.publicId ? body.publicId : 'anon';
    const platform = typeof body.platform === 'string' ? body.platform : undefined;
    const events: ClientAnomalyEvent[] = (body.events as unknown[]).slice(0, 200).flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const o = raw as Record<string, unknown>;
      const msg = typeof o.msg === 'string' ? o.msg.slice(0, 500) : '';
      const type = typeof o.type === 'string' ? o.type.slice(0, 32) : '';
      if (!msg || !type) return [];
      const e: ClientAnomalyEvent = {
        type,
        msg,
        ts: typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : this.deps.now(),
      };
      if (typeof o.detail === 'string' && o.detail) e.detail = o.detail.slice(0, 1000);
      return [e];
    });

    const payload = buildAnomalyLokiPayload(publicId, events, platform, () =>
      (BigInt(this.deps.now()) * 1_000_000n).toString(),
    );
    if (payload) void pushToLoki(this.deps.lokiPushUrl, payload);
    return ok({ accepted: events.length });
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

  // ── 留存（B5，RETENTION_DESIGN）：签到月历 + 每日任务。 ────────────────────────────────────

  /** 读当前留存状态（含定义表，客户端用于渲染月历/任务卡）。 */
  async getRetention(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { cols, now } = this.deps;
    const tsMs = now();
    const save = await getOrCreateSave(cols, accountId, tsMs);
    const retention = resetStaleRetention(save.retention, tsMs);
    return ok({
      checkin: retention.checkin ?? null,
      daily: retention.daily ?? null,
      defs: { rewards: CHECKIN_REWARDS, tasks: DAILY_TASKS, pointsThreshold: DAILY_POINTS_THRESHOLD, dailyCoinsReward: DAILY_COINS_REWARD },
      claimable: {
        checkin: nextCheckinDay(retention, tsMs) !== null,
        daily: dailyRewardClaimable(retention, tsMs),
      },
    });
  }

  /** 签到领当月下一格奖励（幂等：今天已领 → 409）。 */
  async claimCheckin(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { now } = this.deps;
    const tsMs = now();

    let reward: import('@nw/shared').CheckinReward | null = null;
    let claimedDay = 0;
    const recorded = await this.mutateSave(accountId, (s) => {
      const r = resetStaleRetention(s.retention, tsMs);
      const result = claimCheckinDay(r, tsMs);
      if (!result.ok) return result.error;
      reward = result.reward;
      claimedDay = result.day;
      const newRetention = { ...r, checkin: result.newCheckin };
      let next = { ...s, retention: newRetention };
      // 签到奖励：体力类直接给材料；coins 类发币（商业服）
      if (result.reward.kind === 'stamina') {
        next = {
          ...next,
          materials: { ...next.materials, stamina: (next.materials['stamina'] ?? 0) + result.reward.count },
        };
      }
      return next;
    });
    if ('error' in recorded) {
      if (recorded.error === 'ALREADY_CLAIMED_TODAY') {
        return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'already claimed today'));
      }
      if (recorded.error === 'MONTH_FULL') {
        return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'month fully claimed'));
      }
      return reply.code(409).send(err(ErrorCode.REV_CONFLICT, recorded.error));
    }
    // coins 奖励（里程碑）需走 commercial 发币
    let save = recorded.save;
    if (reward && (reward as import('@nw/shared').CheckinReward).kind === 'coins') {
      if (!this.ensureCommercial(reply)) return;
      const { commercial, cols } = this.deps;
      const coins = (reward as import('@nw/shared').CheckinReward).count;
      const orderId = `checkin:${accountId}:${makeMonthKey(tsMs)}:${claimedDay}`;
      const g = await commercial.grant({ accountId, amount: coins, reason: 'checkin', orderId });
      if (g.ok) save = await mirrorCoins(cols, accountId, g.coinsAfter, tsMs);
    }
    return ok({ save, day: claimedDay, reward });
  }

  /** 领当日满点任务金币（幂等：未达阈值 → 400，已领 → 409）。 */
  async claimDailyReward(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { commercial, cols, now } = this.deps;
    const tsMs = now();

    const recorded = await this.mutateSave(accountId, (s) => {
      const r = resetStaleRetention(s.retention, tsMs);
      const result = calcDailyReward(r, tsMs);
      if (!result.ok) return result.error;
      const daily = r.daily!;
      const newRetention = { ...r, daily: { ...daily, rewardClaimed: true } };
      return { ...s, retention: newRetention };
    });
    if ('error' in recorded) {
      if (recorded.error === 'NOT_REACHED') {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'task points not reached'));
      }
      if (recorded.error === 'ALREADY_CLAIMED') {
        return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'daily reward already claimed'));
      }
      if (recorded.error === 'WRONG_DAY') {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'no daily tasks completed today'));
      }
      return reply.code(409).send(err(ErrorCode.REV_CONFLICT, recorded.error));
    }
    const orderId = `daily:${accountId}:${makeDayKey(tsMs)}`;
    const g = await commercial.grant({ accountId, amount: DAILY_COINS_REWARD, reason: 'daily_task', orderId });
    if (!g.ok) return reply.code(502).send(err(ErrorCode.BAD_REQUEST, 'coin grant failed'));
    const save = await mirrorCoins(cols, accountId, g.coinsAfter, tsMs);
    return ok({ save, coins: DAILY_COINS_REWARD });
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

  // ── 社交：好友/私聊/邮件（S6-1/2/3）。P2 起：若配置了 NW_SOCIALSVC_INTERNAL_URL，路由代理到 socialsvc。──

  /** 代理到 socialsvc（透传 JWT + body）。socialsvc 未配置 → 503。 */
  private async proxySocial(
    req: FastifyRequest,
    reply: FastifyReply,
    socialPath: string,
    body?: unknown,
  ): Promise<void> {
    if (!this.deps.socialsvc?.available) {
      reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'socialsvc not configured'));
      return;
    }
    const auth = (req.headers.authorization ?? '') as string;
    const r = await this.deps.socialsvc.proxy(req.method, socialPath, body ?? null, auth);
    reply.status(r.status).send(r.data);
  }

  // ── 社交：好友/私聊/邮件（P2 后全部代理到 socialsvc）──────────────────────────

  async getFriends(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/friends');
  }

  async getFriendRequests(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/friends/requests');
  }

  async getSocialBadges(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/badges');
  }

  async searchFriend(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/friends/search', req.body);
  }

  async requestFriend(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/friends/request', req.body);
  }

  async respondFriend(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/friends/respond', req.body);
  }

  async removeFriend(req: FastifyRequest, reply: FastifyReply) {
    const { publicId } = req.params as { publicId: string };
    return this.proxySocial(req, reply, `/social/friends/${encodeURIComponent(publicId)}`);
  }

  async blockUser(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/friends/block', req.body);
  }

  async unblockUser(req: FastifyRequest, reply: FastifyReply) {
    const { publicId } = req.params as { publicId: string };
    return this.proxySocial(req, reply, `/social/friends/block/${encodeURIComponent(publicId)}`);
  }

  async getConversations(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/chat/conversations');
  }

  async getMessages(req: FastifyRequest, reply: FastifyReply) {
    const { convId } = req.params as { convId: string };
    const q = req.query as { before?: string | number; limit?: string | number };
    const qs = new URLSearchParams();
    if (q.before !== undefined) qs.set('before', String(q.before));
    if (q.limit !== undefined) qs.set('limit', String(q.limit));
    const qStr = qs.toString();
    return this.proxySocial(req, reply, `/social/chat/${encodeURIComponent(convId)}/messages${qStr ? `?${qStr}` : ''}`);
  }

  async sendChat(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/chat/send', req.body);
  }

  async readChat(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/chat/read', req.body);
  }

  // ── 社交：邮件（S6-3）。附件领取 claimMail 经 socialsvc 原子标记后 meta 负责发货。──
  async getMail(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/mail');
  }

  async readMail(req: FastifyRequest, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    return this.proxySocial(req, reply, `/social/mail/${encodeURIComponent(id)}/read`, {});
  }

  async deleteMail(req: FastifyRequest, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    return this.proxySocial(req, reply, `/social/mail/${encodeURIComponent(id)}`);
  }

  async claimMail(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: string };
    const { cols, commercial, now } = this.deps;

    if (!this.deps.socialsvc?.available) {
      return reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'socialsvc not configured'));
    }
    const orderId = randomUUID();
    const claimedResult = await this.deps.socialsvc.claimMail(id, accountId, orderId);
    if ('error' in claimedResult) {
      if (claimedResult.error === 'NOT_FOUND') return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'mail not found'));
      if (claimedResult.error === 'NO_ATTACHMENT') return reply.code(400).send(err(ErrorCode.NO_ATTACHMENT, 'no attachment'));
      return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'already claimed'));
    }
    const attachments = claimedResult.doc.attachments ?? [];
    if (attachments.length === 0) return reply.code(400).send(err(ErrorCode.NO_ATTACHMENT, 'no attachment'));
    const split = splitAttachments(attachments);
    if (split.coins > 0 && !commercial.available) {
      return reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'commercial service unavailable'));
    }
    let coinsAfter: number | null = null;
    if (split.coins > 0) {
      const g = await commercial.grant({ accountId, amount: split.coins, reason: 'mail', orderId });
      if (g.ok) coinsAfter = g.coinsAfter;
    }
    const cur = await getOrCreateSave(cols, accountId, now());
    const newSkins = split.skins.filter((s) => !cur.inventory.skins.includes(s));
    const save = await deliverMailGrant(cols, accountId, orderId, newSkins, split.items, coinsAfter, now(), split.materials);
    return ok({ save });
  }

  async sendMail(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/mail/send', req.body);
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
    const pools = GACHA_POOLS.map((p) => {
      const entries = poolEntries(p);
      const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
      return {
        id: p.id,
        costSingle: p.costSingle,
        costTen: p.costTen,
        pityThreshold: p.pityThreshold,
        dupePolicy: p.dupePolicy,
        // C5-a：每条目附带 probability（Apple 3.1.1 要求）。
        entries: entries.map((e) => ({
          ...e,
          probability: totalWeight > 0 ? e.weight / totalWeight : 0,
        })),
      };
    });
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
      // B5：每日任务「开盲盒」打点，将 retention 合入返回 save，客户端立即看到任务完成。
      await this.bumpRetentionTask(accountId, 'gacha.draw');
      const nextRetention1 = accrueRetentionTask(save.retention, 'gacha.draw', now());
      const saveWithRet1 = nextRetention1 !== save.retention ? { ...save, retention: nextRetention1 } : save;
      return ok({ save: saveWithRet1, results: marked });
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
    // B5：每日任务「开盲盒」打点，将 retention 合入返回 save，客户端立即看到任务完成。
    await this.bumpRetentionTask(accountId, 'gacha.draw');
    const nextRetention2 = accrueRetentionTask(save.retention, 'gacha.draw', now());
    const saveWithRet2 = nextRetention2 !== save.retention ? { ...save, retention: nextRetention2 } : save;
    return ok({ save: saveWithRet2, results: marked });
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
    const save = await mirrorCoins(cols, accountId, credit.coinsAfter, now());
    // B6：活动任务「ad.watch」打点（best-effort）。
    accrueEventTask(cols, accountId, 'ad.watch', now()).catch(() => {});
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

    // 原子校验 + 记领取（乐观锁防双击）。材料奖励在同一事务内写入 save.materials。
    let claimedReward: { kind: string; count: number } | null = null;
    const out = await this.mutateSave(accountId, (s) => {
      const bp = s.battlePass;
      if (!bp) return 'NO_BATTLEPASS';
      const r = claimBpReward(bp, track, level);
      if (!r.ok) return r.error;
      claimedReward = r.reward;
      const next = { ...s, battlePass: r.bp };
      if (r.reward.kind === 'material' && r.reward.id && r.reward.count > 0) {
        next.materials = { ...s.materials, [r.reward.id]: (s.materials[r.reward.id] ?? 0) + r.reward.count };
      }
      return next;
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

  // ── B6 限时活动 ───────────────────────────────────────────────────────────

  async getEvents(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols, now } = this.deps;
    const events = await getEventsForAccount(cols, accountId, now());
    return reply.send({ ok: true, data: { events } });
  }

  async claimEventReward(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { eventId, rewardId } = req.body as { eventId: string; rewardId: string };
    if (!eventId || !rewardId) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing eventId/rewardId'));
    const { cols, now, commercial } = this.deps;
    const result = await claimEventReward(cols, accountId, eventId, rewardId, now(), commercial);
    if (!result.ok) {
      const code =
        result.error === 'NOT_FOUND' ? 404 :
        result.error === 'EVENT_CLOSED' ? 403 :
        result.error === 'INSUFFICIENT_POINTS' ? 402 :
        409;
      const errCode =
        result.error === 'NOT_FOUND' ? ErrorCode.NOT_FOUND :
        result.error === 'EVENT_CLOSED' ? ErrorCode.BAD_REQUEST :
        result.error === 'INSUFFICIENT_POINTS' ? ErrorCode.INSUFFICIENT_FUNDS :
        ErrorCode.ALREADY_CLAIMED;
      return reply.code(code).send(err(errCode, result.error));
    }
    return reply.send({ ok: true, data: { pointsLeft: result.pointsLeft, reward: result.reward } });
  }

  // ── S10 称号端点（L2-2，TITLE_DESIGN）：玩家侧读取已授予称号 + 选用显示称号。 ────────────
  // 存储复用 save.titles[] / save.equipped.title（服务器权威，PUT /save 不可写此二字段）；
  // 称号 source/seasonNo 由 titleId 命名约定派生（parseTitleId，与客户端展示同源），授予时间不入库。

  /** 读当前账号全量已授予称号（含派生 source/seasonNo）+ 当前佩戴称号。 */
  async getTitles(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const save = await getOrCreateSave(this.deps.cols, accountId, this.deps.now());
    const titles = (save.titles ?? []).map((id) => {
      const { source, seasonNo } = parseTitleId(id);
      return { id, source, ...(seasonNo != null ? { seasonNo } : {}) };
    });
    return ok({ titles, equipped: save.equipped?.title ?? null });
  }

  /**
   * 选用当前显示称号 → 写 save.equipped.title → 回推完整存档。
   * 仅允许已授予的称号；空串 titleId 视为卸下（清空佩戴）。
   */
  async equipTitle(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { titleId } = req.body as { titleId?: string };
    const out = await this.mutateSave(accountId, (s) => {
      const owned = s.titles ?? [];
      // 空串 = 卸下显示称号
      if (titleId === '' || titleId == null) {
        const { title: _drop, ...restEquipped } = s.equipped ?? {};
        return { ...s, equipped: restEquipped };
      }
      if (!owned.includes(titleId)) return 'NOT_OWNED';
      return { ...s, equipped: { ...s.equipped, title: titleId } };
    });
    if ('error' in out) {
      if (out.error === 'NOT_OWNED') {
        return reply.code(403).send(err(ErrorCode.BAD_REQUEST, 'title not owned'));
      }
      return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
    }
    return ok({ save: out.save });
  }
}
