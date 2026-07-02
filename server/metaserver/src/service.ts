// metaserver serviceHandlers: operationId from openapi.yml → method (assembled by fastify-openapi-glue).
// Validation/routing is handled by glue according to the spec; this file contains only business logic. S0 implements auth + save;
// economy/gacha/IAP (S2/S4) return NOT_IMPLEMENTED as placeholders for now — contracts are ready.
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
  CARD_DEFS,
  levelCardReward,
  UNIT_CARD_POOL_ID,
  type CardDef,
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
  buildLimitedPool,
  ADS_REWARD_COINS,
  ADS_DAILY_CAP,
  ADS_MIN_INTERVAL_MS,
  RENAME_COST,
  PRODUCT_STARTER_GROWTH,
  GROWTH_PACK_WINDOW_DAYS,
  type GachaPoolDef,
} from '@nw/shared';
import { CHAT_SEND_RATE_PER_MIN, regionFromAcceptLanguage } from '@nw/shared';
import { ACHIEVEMENTS, findAchievement, validateClaim } from '@nw/shared';
import { parseTitleId } from '@nw/shared';
import { getOrCreateSave, putSave, writeMigratedSave } from './save.js';
import { getCurrentSeason, migrateIfStale } from './ladderSeason.js';
import { craftEquipment, enhanceEquipment, salvageEquipment, equipEquipment, reforgeEquipment, grantEquipment } from './equipment.js';
import { grantCards, feedCards, grantCard } from './cards.js';
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
  deliverOrder,
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
import { nullMetaSocialsvcClient } from './socialsvcClient.js';

export interface ServiceDeps {
  cols: Collections;
  jwt: JwtConfig;
  now: () => number;
  commercial: CommercialClient;
  /** Public WebSocket address of the gateway, sent down with auth/save responses; null = not sent (client falls back to its own config). */
  gatewayPublicUrl: string | null;
  /** Internal gateway client: PvE L1 replay spot-checks dispatch a third-party headless re-simulation via /gw/judge. If not configured, spot-checking is skipped (materials are delivered directly). */
  gateway: GatewayClient;
  /** Maximum auth attempts per IP within 15 minutes. 0 = disabled (for tests/CI). */
  authRateLimit: number;
  /** Feature flag cache (evaluated for the public /bootstrap endpoint; FEATURE_FLAGS_DESIGN §9.3). null = no flag source, bootstrap always returns an empty map. */
  flags: FeatureFlagCache | null;
  /** Deployment region (injected into flag evaluation context). */
  region: string | null;
  /** Loki push URL (POST /client/log forwards client logs; null = silently dropped). */
  lokiPushUrl: string | null;
  /** Internal socialsvc client (P2): friend/chat/mail routing proxy + atomic mail claim. null = routing is handled by metaserver itself. */
  socialsvc: import('./socialsvcClient.js').MetaSocialsvcClient | null;
}

/** Retrieve the accountId written by the security handler (the handler guarantees the request is authenticated). */
function accountIdOf(req: FastifyRequest): string {
  const id = req.accountId;
  if (!id) throw new Error('accountId missing after auth');
  return id;
}

/** Normalize the upgrade map (remove zero-value entries + sort keys) for stable cross-source comparison (L0 blueprint anomaly detection). */
function normUpgrades(u: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(u).sort()) {
    const v = u[k] ?? 0;
    if (v > 0) out[k] = v;
  }
  return out;
}

/** In-process sliding-window rate limiter keyed by IP/key. */
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
 * Maximum blob size for state-stream shares. The blob is a gzip+base64 **compressed string** produced by the client (§7),
 * with a compression ratio of ~10-20×, so a 2 MB compressed string is sufficient for a very long match.
 * Requests exceeding this limit are rejected (indicating the match is too long). Fastify bodyLimit is set to ≥ this value
 * (see app.ts) so that our graceful 400 fires before Fastify's 413.
 */
const STATE_REPLAY_MAX_BYTES = 2 * 1024 * 1024;
/** Expiry duration in days for state-stream shares (initially 14 days; permanent vs. N-day policy to be decided at launch, §7). */
const STATE_REPLAY_EXPIRE_DAYS = 14;
/** Per-account share minting rate limit: maximum shares per hour. */
const STATE_REPLAY_SHARE_PER_HOUR = 20;

/** Client-facing gacha pool view (GACHA_DESIGN §2 + §8): static + active limited pools with per-entry odds. */
interface PoolView {
  id: string;
  costSingle: number;
  costTen: number;
  pityThreshold: number;
  dupePolicy: string;
  limited?: boolean;
  name?: string;
  featuredLegendary?: string;
  endAt?: number;
  entries: { itemId: string; weight: number; rarity: string; probability: number }[];
}

export class MetaService {
  private readonly oauth = createOAuthService();
  private readonly authRate: { allow(key: string, now: number): boolean };
  /** Rate limit for "full coverage" anomaly event uploads, keyed by IP: at most 30 POST /client/anomaly requests per IP per 60s (guards against Loki flooding). In-process approximation. */
  private readonly anomalyRate = new SlidingRateLimiter(30, 60 * 1000);

  constructor(private readonly deps: ServiceDeps) {
    this.authRate = deps.authRateLimit > 0
      ? new SlidingRateLimiter(deps.authRateLimit, 15 * 60 * 1000)
      : { allow: () => true };
  }

  /**
   * Direct-message send rate limit (SOC2): sliding window of send timestamps per account within the last 60s.
   * In-process (when meta scales out stateless, this becomes a per-instance approximation — sufficient to prevent
   * message flooding; precise global limiting requires Redis). Returns true = allowed and recorded, false = over limit.
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
   * Login/register IP rate limit (S4-3): at most authRateLimit auth attempts per IP within 15 minutes (prevents brute-force credential stuffing).
   * In-process approximation (per-instance when scaled out — sufficient to defend against single-machine attacks; precise global limiting requires Redis).
   * Disabled when authRateLimit=0 (for CI/tests).
   */
  private allowAuthAttempt(req: FastifyRequest, now: number): boolean {
    const ip = req.ip ?? 'unknown';
    return this.authRate.allow(ip, now);
  }

  /**
   * State-stream share minting rate limit (REPLAY_SHARE_DESIGN §3.1): sliding window of mint counts per account within the last 1 hour.
   * In-process approximation (per-instance when meta scales out — sufficient to prevent flooding). Returns true = allowed and recorded.
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

  /** Public WebSocket address of the gateway (only sent if configured). Clients use this to connect to the control plane without hardcoding the gateway address. */
  private get gatewayField(): { gatewayUrl?: string } {
    return this.deps.gatewayPublicUrl ? { gatewayUrl: this.deps.gatewayPublicUrl } : {};
  }

  // ── auth ──────────────────────────────────────────

  /** C4/C5-b: Check account-level ban / soft-delete flags; if flagged, reject the request and return true. */
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

  /** Grant lichuang/chenshou/suyuan to a brand-new account (CHARACTER_CARDS_DESIGN §4). No-op if account already has cards. */
  private async maybeGrantStarterCards(accountId: string, isNew: boolean): Promise<void> {
    if (!isNew) return;
    const { cols, now } = this.deps;
    const save = await getOrCreateSave(cols, accountId, now());
    if (Object.keys(save.cardInv ?? {}).length > 0) return;
    await grantCards(cols, now, accountId, [
      CARD_DEFS['lichuang']!,
      CARD_DEFS['chenshou']!,
      CARD_DEFS['suyuan']!,
    ]);
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
    await this.maybeGrantStarterCards(accountId, isNew);
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
    await this.maybeGrantStarterCards(accountId, isNew);
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
    await this.maybeGrantStarterCards(accountId, isNew);
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
    await this.maybeGrantStarterCards(accountId, isNew);
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
   * C5-b Account soft-delete (required by Apple 5.1.1(v)).
   * Writes accounts.deletedAt; subsequent auth calls return ACCOUNT_DELETED (410).
   * Async cleanup after the 7-day grace period is triggered by admin/cron (this phase only marks the account).
   */
  async deleteAccount(req: FastifyRequest) {
    const accountId = accountIdOf(req);
    const { cols, now } = this.deps;
    const confirmToken = randomUUID();
    await cols.accounts.updateOne({ _id: accountId }, { $set: { deletedAt: now() } });
    return ok({ confirmToken });
  }

  /** C5-c GDPR consent recording: sets accounts.flags.gdprConsent=true. */
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
   * OAuth third-party login (SA-2): authorization code flow, initially supporting Google.
   * The server exchanges the code for an access_token → retrieves sub → upserts the account.
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
    await this.maybeGrantStarterCards(accountId, isNew);
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
   * Bind a credential to the current account (SA-2): convert anonymous account to registered + bind multiple credentials.
   * method='oauth': same as authOAuth, but binds to the existing account identified by the JWT (no new account created).
   * method='password': assigns a password to the account (idempotent if a password already exists).
   * If the target credential already belongs to another account → ALREADY_BOUND.
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
   * Change display name (costs RENAME_COST coins). First deducts from commercial (name unchanged if insufficient balance);
   * on success, writes the new name + mirrors the wallet back into the authoritative save + returns the new displayName.
   * Requires login + commercial service available.
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
    await getOrCreateSave(cols, accountId, now()); // ensure save document exists
    // Also reconcile + refresh wallet mirror (when commercial is available): re-deliver orders left from crashes + pull authoritative balance/pity into the mirror.
    if (commercial.available) {
      try {
        await reconcileUndelivered(cols, commercial, accountId, now());
        const w = await commercial.getWallet(accountId);
        if (w) await mirrorWalletFrom(cols, accountId, w, now());
      } catch (e) {
        req.log.warn({ err: e }, 'commercial reconcile/mirror failed (serving local save)');
      }
    }
    let save = await getOrCreateSave(cols, accountId, now());
    // Lazy season migration (S11): if pvp.seasonNo is behind, settle previous-season rewards + soft-reset + update battle pass.
    try {
      const socialsvc = this.deps.socialsvc ?? nullMetaSocialsvcClient;
      const currentSeason = await getCurrentSeason(cols, now());
      const r = await migrateIfStale(cols, commercial, socialsvc, save, currentSeason, now());
      if (r.migrated) {
        save = await writeMigratedSave(
          cols,
          r.save,
          now(),
          (s) => migrateIfStale(cols, commercial, socialsvc, s, currentSeason, now()),
        );
      }
    } catch (e) {
      req.log.warn({ err: e }, 'season migrate failed (serving pre-migration save)');
    }
    // Stamina snapshot injection (A4): stamina is stored in a separate collection and merged into the save mirror on response.
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

  // ── PvE server authority (PVE_INTEGRITY_PLAN §8): clear settlement + upgrades. progress/stars/materials/
  //    pveUpgrades are only written here + in ranked settlement; putSave does not accept them (trust boundary, §8.3). ──────────

  /** Optimistic-lock read-modify-write on the save document (rev guard + retry, same as applyPvp). transform returns the new save or a business error code string. */
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
      // rev conflict (concurrent client PUT of equipped/flags or concurrent pve write) → re-read and retry
    }
    return { error: 'REV_CONFLICT' };
  }

  /** Increment today's "material-rewarding clear" count by 1 (only claims a slot and returns true when below cap), same two-step pattern as bumpAdsCap. */
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

  // ── Stamina system (A4) ──────────────────────────────────────────────────────────

  private static readonly STAMINA_CAP = 120;
  private static readonly STAMINA_REGEN_MS = 6 * 60 * 1000; // 6 min per point

  /**
   * Atomically deduct stamina: read pveStamina → apply natural regen → $inc with balance check.
   * Returns { ok: true, current } or { ok: false } (insufficient balance).
   */
  private async deductStamina(
    accountId: string,
    cost: number,
    now: number,
  ): Promise<{ ok: true; current: number; regenAt: number } | { ok: false }> {
    const { cols } = this.deps;
    const CAP = MetaService.STAMINA_CAP;
    const REGEN_MS = MetaService.STAMINA_REGEN_MS;

    // Lazily create the document (new account's first level entry).
    await cols.pveStamina.updateOne(
      { _id: accountId },
      { $setOnInsert: { _id: accountId, current: CAP, regenAt: 0 } },
      { upsert: true },
    );

    // Apply natural regen first (two-step: read → compute → write; a tiny concurrent window may grant 1 extra point, which is extremely unlikely and player-friendly).
    const stDoc = await cols.pveStamina.findOne({ _id: accountId });
    if (!stDoc) return { ok: false }; // theoretically unreachable (upsert already created it)

    let { current, regenAt } = stDoc;
    if (current < CAP && regenAt > 0 && now >= regenAt) {
      const ticks = Math.floor((now - regenAt) / REGEN_MS) + 1;
      current = Math.min(CAP, current + ticks);
      regenAt = current >= CAP ? 0 : regenAt + ticks * REGEN_MS;
      await cols.pveStamina.updateOne({ _id: accountId }, { $set: { current, regenAt } });
    }

    if (current < cost) return { ok: false };

    // Atomic deduction ($inc with $gte guard to prevent concurrent over-deduction).
    const newCurrent = current - cost;
    // Regen timer: if the deduction drops current below cap, start timing; if already counting, keep regenAt unchanged.
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
    if (!res) return { ok: false }; // lost concurrent race
    return { ok: true, current: res.current, regenAt: res.regenAt };
  }

  /** Read current stamina (including natural regen calculation), used to populate the SaveData.stamina snapshot in responses. */
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

  /** Purchase stamina (deducts coins via commercial; 60 stamina = 30 coins, §A4). */
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
    // Add stamina (capped at CAP; excess is discarded).
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

  /** Write progress/stars (unlock + record stars, taking the max), without touching materials. */
  private async writeClearProgress(accountId: string, levelId: string, stars: number) {
    return this.mutateSave(accountId, (s) => {
      const cleared = s.progress.cleared.includes(levelId)
        ? s.progress.cleared
        : [...s.progress.cleared, levelId];
      const stars2 = Math.max(s.progress.stars[levelId] ?? 0, stars) as 1 | 2 | 3;
      // Achievement stat (S9-3, ACHIEVEMENT_DESIGN §4.2.2): accumulate campaign.chaptersCleared on first chapter clear,
      // in the same mutateSave transaction as progress (rev guard) — naturally authoritative and tamper-resistant. $max semantics → increments only on first clear, not on replays.
      // Lazy default creation: if no chapters cleared (count=0) and no existing stats, stats is not instantiated (saves storage).
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
   * PvE stat feed (S9-3b): accumulate the in-match achievement counters (`kill.*`/`cast.*`) returned by the judge's re-simulation into the player's lifetime stats.
   * If statsJson fails to parse or is not an object → skip; passes through {@link sanitizePvpReportedStats} (L1 caps as a backstop against "colluding with the judge to farm stats";
   * out-of-bounds data is discarded entirely, without blocking material delivery); empty increments do not instantiate stats (lazy creation).
   * Errors are not thrown (stat feeding is a best-effort side effect and must never block the material delivery main path — the coin pool is small and one-time, §4.4).
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
    if (!clean || Object.keys(clean).length === 0) return; // L1 out-of-bounds rejected / nothing to accumulate
    await this.mutateSave(accountId, (s) => {
      const stats = accrueStats(s.stats, clean);
      return stats === s.stats ? s : { ...s, stats };
    });
  }

  /** B5: Idempotently record a daily task event (no-op if already recorded today, no error thrown). Callers fire-and-forget and ignore failures. */
  private async bumpRetentionTask(accountId: string, taskId: import('@nw/shared').DailyTaskId): Promise<void> {
    const tsMs = this.deps.now();
    await this.mutateSave(accountId, (s) => {
      const next = accrueRetentionTask(s.retention, taskId, tsMs);
      if (next === s.retention) return s; // already recorded today, no-op
      return { ...s, retention: next };
    }).catch(() => {/* retention recording failure does not affect the main flow */});
  }

  /**
   * Deliver level rewards within the daily cap (material reward + card instance grants, CC-2).
   * Material reward is written atomically in a single mutateSave transaction.
   * Card rewards are mapped to CardDef instances and granted at level=2 via the async grantCards
   * (own rev loop, separate call). Equipment drop is rolled independently of the daily cap.
   * Returns actually delivered amounts (all empty if capped) + capped flag + save.
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
    const { cols, now } = this.deps;
    const cardReward = levelCardReward(levelId);
    const hasReward = Object.keys(reward).length > 0 || Object.keys(cardReward).length > 0;
    const capped = hasReward ? !(await this.bumpPveRewardCap(accountId, now())) : false;
    const grant: Record<string, number> = capped ? {} : { ...reward };
    const cardGrant: Record<string, number> = capped ? {} : { ...cardReward };

    // Map unitType → CardDef for the new Hero Roster grant (CHARACTER_CARDS_DESIGN §4)
    const defsToGrant: CardDef[] = [];
    for (const [unitType, count] of Object.entries(cardGrant)) {
      const def = Object.values(CARD_DEFS).find((d) => d.unitType === unitType);
      if (def) for (let i = 0; i < count; i++) defsToGrant.push(def);
    }

    // Equipment drop roll (independent of the daily cap; rolled outside mutateSave to avoid non-determinism from Math.random inside the transaction)
    const dropCfg = findPveLevel(levelId)?.equipmentDrop;
    const pendingDrop: EquipmentInstance | undefined =
      dropCfg && Math.random() < dropCfg.rate
        ? (makeDropInstance(dropCfg.rarity, `drop_${randomUUID()}`) as EquipmentInstance)
        : undefined;

    // Material reward + equipment drop (single atomic write)
    const out = await this.mutateSave(accountId, (s) => {
      const materials = { ...s.materials };
      for (const [m, n] of Object.entries(grant)) materials[m] = (materials[m] ?? 0) + n;
      let next = { ...s, materials };
      // Store equipment (silently skipped when inventory is full)
      if (pendingDrop && equipmentInvCount(next) < EQUIPMENT_INV_CAP) {
        next = { ...next, equipmentInv: { ...(next.equipmentInv ?? {}), [pendingDrop.id]: pendingDrop } };
      }
      return next;
    });
    if ('error' in out) return out;

    // Card instance grant at level=2 (separate rev loop; compensation coins dropped — [DRAFT: wire commercial])
    let latestSave = out.save;
    if (defsToGrant.length > 0) {
      const cardResult = await grantCards(cols, now, accountId, defsToGrant, 2);
      if ('error' in cardResult) return cardResult;
      latestSave = cardResult.save;
    }

    // Confirm the drop was actually written (pendingDrop is not stored when inventory is full)
    const grantedEquipment =
      pendingDrop && latestSave.equipmentInv?.[pendingDrop.id] ? pendingDrop : undefined;
    return { save: latestSave, granted: grant, grantedCards: cardGrant, grantedEquipment, capped };
  }

  /**
   * PvE clear settlement: validate unlock → write progress/stars → deliver materials (within daily cap) → push back.
   * L1 spot-check (§8.6 step 3): if selected (first clear / blueprint anomaly / random) and a judge is available, **do not deliver materials yet**;
   * record a pveVerifications entry and respond with `needsReplay + verifyId` so the client can submit the replay to /pve/verify for re-simulation and credit.
   */
  async pveClear(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols, now, gateway } = this.deps;
    const { levelId, stars: starsRaw, pveUpgrades: clientUpgradesLegacy, unitLevels: clientUnitLevels, stats: clientStats } = req.body as {
      levelId: string;
      stars: number;
      /** @deprecated S3-2, replaced by unitLevels from S12 onwards. */
      pveUpgrades?: Record<string, number>;
      /** S12 unit progression level snapshot (client snapshot at match start, used for L0 anomaly detection). */
      unitLevels?: Record<string, number>;
      /** S9-3b: client-reported in-match kill/cast stats (used for achievement counting on the non-spot-check path). */
      stats?: Record<string, number>;
    };
    const level = findPveLevel(levelId);
    if (!level) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown level'));
    const stars = Math.floor(starsRaw);
    if (stars < 1 || stars > 3) {
      // A clear requires at least 1 star; 0 stars does not count as cleared (consistent with the stars>0 gate in the client's applyCampaignClear).
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'stars must be 1..3'));
    }

    if (await this.rejectIfBanned(cols, accountId, reply)) return;
    const cur = await getOrCreateSave(cols, accountId, now());
    if (cur.antiCheat?.pveBanned) {
      return reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account banned'));
    }
    // Prerequisite unlock check: the prerequisite level must already be cleared (newly offline-unlocked levels are rejected, §8 decision 4).
    if (level.requires && !cur.progress.cleared.includes(level.requires)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'level locked'));
    }

    // Stamina deduction (A4): deduct before settling to prevent settle-then-reject scenarios.
    const staminaCost = level.staminaCost ?? 1;
    const staminaResult = await this.deductStamina(accountId, staminaCost, now());
    if (!staminaResult.ok) {
      return reply.code(402).send(err(ErrorCode.INSUFFICIENT_STAMINA, 'not enough stamina'));
    }

    // Exploitable reward = either material reward or unit card drop is non-empty (S12-C: cards are also a cheatable reward).
    const hasReward =
      Object.keys(level.reward).length > 0 || Object.keys(levelCardReward(levelId)).length > 0;

    // L1 spot-check decision: only considered when "rewards are available + judge is available" (otherwise there is no exploitable reward to cheat).
    if (hasReward && gateway.available) {
      const isFirstClear = !cur.progress.cleared.includes(levelId);
      // L0 anomaly (§0 "combat power mismatch at match start → must be cheating"): S12 prefers comparing unitLevels; falls back to pveUpgrades if unavailable.
      const blueprintMismatch = clientUnitLevels !== undefined
        ? JSON.stringify(normUpgrades(clientUnitLevels)) !== JSON.stringify(normUpgrades({}))
        : clientUpgradesLegacy !== undefined &&
          JSON.stringify(normUpgrades(clientUpgradesLegacy)) !== JSON.stringify(normUpgrades(cur.pveUpgrades));
      if (shouldSpotCheck({ isFirstClear, blueprintMismatch, rand: Math.random() })) {
        const reason = blueprintMismatch ? 'anomaly' : isFirstClear ? 'first' : 'sample';
        // Write progress/stars (unlock proceeds normally) but do not deliver materials; record the spot-check and wait for the client to submit the replay for re-simulation.
        const prog = await this.writeClearProgress(accountId, levelId, stars);
        if ('error' in prog) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, prog.error));
        const verifyId = randomUUID();
        await cols.pveVerifications.insertOne({
          _id: verifyId,
          accountId,
          levelId,
          claimedStars: stars,
          pveUpgrades: { ...cur.pveUpgrades }, // legacy snapshot (kept for compatibility)
          unitLevels: {}, // unitLevels removed in CC-1 (SaveData v4); re-simulation uses cardInv
          reason,
          status: 'pending',
          // S9-3b: store client-reported counts as an audit comparison baseline (verdict.statsJson is the authoritative source; the reported field is for ops visibility only).
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

    // Normal clear: write progress/stars then deliver materials + unit cards (within the daily cap, S12-C).
    const prog = await this.writeClearProgress(accountId, levelId, stars);
    if ('error' in prog) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, prog.error));
    const granted = await this.grantClearReward(accountId, levelId, level.reward);
    if ('error' in granted) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, granted.error));
    // S9-3b: non-spot-check path — accept client-reported stats, pass through L1 caps, then write to achievement counters.
    if (clientStats) await this.accrueJudgedPveStats(accountId, JSON.stringify(clientStats));
    // B5: record daily task "clear PvE" (idempotent, no-op if already recorded today).
    await this.bumpRetentionTask(accountId, 'pve.clear');
    // B6: record event task "pve.clear" (best-effort).
    accrueEventTask(cols, accountId, 'pve.clear', now()).catch(() => {});
    // Merge the retention update into the returned save so the client sees the task completion immediately after adoptServer.
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
   * PvE L1 replay spot-check re-simulation (§8.6 step 3): client submits the replay frames of the flagged clear → dispatched via gateway to a third-party
   * online client for headless re-simulation (reuses S1-J, campaign mode + server-authoritative blueprint snapshot) → materials delivered only if re-simulated stars ≥ claimed.
   * If no judge is available (no candidates / timeout / re-simulation failure) → benefit-of-doubt: deliver anyway (honest players are not penalized for missing judges);
   * if re-simulated stars < claimed → flagged as suspicious, materials not delivered + recorded as rejected.
   */
  async pveVerify(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols, gateway, now } = this.deps;
    const { verifyId, frames, endFrame } = req.body as {
      verifyId: string;
      frames: { frame: number; cmds: { side: number; commands: string }[] }[];
      endFrame: number;
    };
    // S4-4: banned accounts cannot submit verifications.
    const save = await cols.saves.findOne({ _id: accountId }, { projection: { 'save.antiCheat': 1 } });
    if (save?.save?.antiCheat?.pveBanned) {
      return reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account banned'));
    }
    const doc = await cols.pveVerifications.findOne({ _id: verifyId });
    if (!doc || doc.accountId !== accountId) {
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'verification not found'));
    }
    if (doc.status !== 'pending') {
      // Already settled (duplicate submission) → idempotent: return current save, do not deliver again.
      const s = await getOrCreateSave(cols, accountId, now());
      return ok({ save: s, granted: {}, capped: false, verified: doc.status !== 'rejected' });
    }
    const level = findPveLevel(doc.levelId);
    if (!level) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown level'));

    // Dispatch third-party headless re-simulation (seed derived locally by the judge from the level JSON; mode is audit-only, PvE uses levelId).
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
    // Re-simulation succeeded and stars < claimed → suspicious, do not deliver materials. All other outcomes (passed / no judge available) deliver materials.
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

      // C4: account-level pveWarnings count + warning mail + ban (intercepted at the auth layer).
      const updatedAcc = await cols.accounts.findOneAndUpdate(
        { _id: accountId },
        { $inc: { 'flags.pveWarnings': 1 } },
        { returnDocument: 'after', projection: { 'flags.pveWarnings': 1 } },
      );
      const newWarnings = updatedAcc?.flags?.pveWarnings ?? 1;
      if (newWarnings === 1) {
        // Best-effort: a failed warning mail must not block the reject-count/ban flow above.
        await insertSystemMail(this.deps.socialsvc ?? nullMetaSocialsvcClient, `pve-warn-${verifyId}`, accountId, {
          subject: 'Fair Play Warning',
          body: 'Unusual PvE activity was detected. Continued violations may result in account suspension.',
          expireDays: 30,
        }).catch((e) => req.log.warn({ err: e }, 'pve-warn mail failed'));
      }
      if (newWarnings >= PVE_REJECT_BAN_THRESHOLD) {
        await cols.accounts.updateOne({ _id: accountId }, { $set: { 'flags.banned': true } });
      }

      const s = 'error' in saved ? await getOrCreateSave(cols, accountId, now()) : saved.save;
      return ok({ save: s, granted: {}, capped: false, verified: false });
    }
    // PvE stat feed (S9-3b, ACHIEVEMENT_DESIGN §6.2): only when the **judge successfully re-simulated** (status==='verified', not benefit-of-doubt 'unverified'),
    // accumulate the judge-authoritative in-match kill/cast counts into lifetime stats.
    // The judge is a random third-party headless re-simulation → players cannot fabricate it; still passes through L1 caps as a cheap backstop against
    // "player colluding with the judge to farm stats" (out-of-bounds data discarded entirely, does not block material delivery). A2: counts are only written at this server-authoritative settlement point.
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

  /** S1-RP: Create a 7-day share link (shareId) for an existing Mongo replayBlob. */
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

  /** S1-RP: Retrieve a replay by shareId (no login required; automatically expires when the TTL elapses). */
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
   * State-stream replay out-of-game share — mint a share code (REPLAY_SHARE_DESIGN §3.1). The sharer must be logged in; the client-generated
   * state-stream blob is uploaded with the request. The server **does not touch the engine or stat tables** — it acts purely as access-controlled object storage:
   * validate size limit + per-account rate limit → write to DB → return an unguessable shareCode. State streams are **untrusted** and must never enter anti-cheat/settlement.
   */
  async createStateReplayShare(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols, now } = this.deps;
    const ts = now();

    if (!this.allowStateShare(accountId, ts)) {
      return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many shares, try later'));
    }

    // blob = gzip+base64 compressed string produced by the client (opaque; the server does not decompress or interpret it, §7).
    const blob = (req.body as { blob?: unknown }).blob;
    if (typeof blob !== 'string' || blob.length === 0) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing replay blob'));
    }
    const sizeBytes = Buffer.byteLength(blob);
    if (sizeBytes > STATE_REPLAY_MAX_BYTES) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'replay too large'));
    }

    // Unguessable random string (144-bit base64url) to prevent enumeration.
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
   * State-stream replay — public retrieval (REPLAY_SHARE_DESIGN §3.2). **No login required**; returns the blob + increments viewCount;
   * not found / expired → 404 (client landing page shows a "Try the Game" CTA).
   */
  async getStateReplayShare(req: FastifyRequest, reply: FastifyReply) {
    const { shareCode } = req.params as { shareCode: string };
    const { cols } = this.deps;
    const doc = await cols.stateReplayShares.findOne({ _id: shareCode });
    if (!doc) return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'share not found'));
    // Increment view count (non-blocking, does not delay response).
    void cols.stateReplayShares.updateOne({ _id: shareCode }, { $inc: { viewCount: 1 } });
    return ok({ blob: doc.blob });
  }

  // ── F3 public bootstrap + targeted client log collection (FEATURE_FLAGS_DESIGN §9) ────────────────────
  /** 4 client log level flags (ordered by verbosity; for documentation/guard use only). */
  private static readonly CLIENT_LOG_KEYS = FLAG_KEYS.filter((k) => k.startsWith('client_log_'));

  /** Parse the flag evaluation context from the request: platform/publicId from query params + optional accountId from token. */
  private flagCtx(req: FastifyRequest): FlagContext {
    const q = (req.query ?? {}) as { platform?: unknown; publicId?: unknown };
    const ctx: FlagContext = {};
    if (typeof q.publicId === 'string' && q.publicId) ctx.publicId = q.publicId;
    if (typeof q.platform === 'string' && (FLAG_PLATFORMS as readonly string[]).includes(q.platform)) {
      ctx.platform = q.platform as FlagPlatform;
    }
    if (this.deps.region) ctx.region = this.deps.region;
    // Login state is optional: if a token is provided, parse the accountId for more precise evaluation; missing/invalid token is silently ignored (bootstrap is callable anonymously).
    const token = extractBearer(req.headers['authorization']);
    if (token) {
      try { ctx.accountId = verifyToken(token, this.deps.jwt); } catch { /* anonymous */ }
    }
    return ctx;
  }

  /**
   * Public bootstrap (§9.3): callable anonymously (a token injects accountId for more precise evaluation). Evaluates all flags individually,
   * **only returning flags that differ from their default** — the vast majority of players receive an empty map → zero overhead. Rules/allowlists are never sent down; only boolean results.
   * No flag source (admin not configured) → always returns an empty map.
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
    // Paddle.js client token (COMMERCIAL_DESIGN §IAP client): the web client needs this to open
    // the checkout overlay. It is a public, client-safe token (ptok_/live_/test_); only sent when
    // configured, so non-web / unconfigured deployments receive nothing extra.
    const paddleClientToken = process.env.NW_PADDLE_CLIENT_TOKEN;
    return ok(paddleClientToken ? { flags, paddleClientToken } : { flags });
  }

  /** Whether this publicId is currently named in the allowPublicIds of any client_log_* flag (prevents arbitrary clients from flooding Loki with logs). */
  private isClientLogTargeted(publicId: string): boolean {
    const cache = this.deps.flags;
    if (!cache) return false;
    for (const key of MetaService.CLIENT_LOG_KEYS) {
      if (cache.rawDoc(key)?.rollout?.allowPublicIds?.includes(publicId)) return true;
    }
    return false;
  }

  /**
   * Client log upload → Loki (§9.4). **Always returns 200** (never affects players). Abuse prevention: only forwards when this publicId is currently targeted
   * by a client_log_* flag; otherwise silently discarded (non-targeted clients receive an empty map from bootstrap and would not call this endpoint in the first place — this is a backstop).
   * Silently discarded if Loki is unreachable.
   */
  async clientLog(req: FastifyRequest, reply: FastifyReply) {
    const body = (req.body ?? {}) as { publicId?: unknown; platform?: unknown; logs?: unknown };
    const publicId = typeof body.publicId === 'string' ? body.publicId : '';
    if (!publicId || !Array.isArray(body.logs)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing publicId / logs'));
    }
    // Not targeted → accept but discard (no 4xx to avoid leaking "who is being collected").
    if (!this.isClientLogTargeted(publicId)) return ok({ accepted: 0 });

    const platform = typeof body.platform === 'string' ? body.platform : undefined;
    // Safety cap: at most 1000 entries, each msg truncated to 2000 characters (Fastify bodyLimit already blocks oversized bodies).
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
      // fire-and-forget: does not block the response; failures are silent (attach onError only when needed during debugging).
      void pushToLoki(this.deps.lokiPushUrl, payload);
    }
    return ok({ accepted: entries.length });
  }

  /**
   * "Full coverage" client anomaly event upload → Loki (complements targeted collection, **not subject to allowPublicIds constraints**:
   * any client's memory overrun / sustained CPU saturation / WebGL context loss / freeze / uncaught exception / last crash is reported directly, enabling field anomaly diagnosis across the entire player base).
   * Abuse prevention: rate-limited to 30 requests per IP per 60s (over-limit silently discarded, still returns 200 — never affects players); at most 200 events, all fields truncated.
   * **Always returns 200** (Loki unreachable / rate-limited / invalid input also does not affect players).
   */
  async clientAnomaly(req: FastifyRequest, reply: FastifyReply) {
    const body = (req.body ?? {}) as { publicId?: unknown; platform?: unknown; events?: unknown };
    if (!Array.isArray(body.events)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing events'));
    }
    // IP rate limit: over-limit is silently discarded (no 4xx, to prevent clients from retrying based on the response / probing the rate limit threshold).
    if (!this.anomalyRate.allow(req.ip ?? 'unknown', this.deps.now())) return ok({ accepted: 0 });

    // publicId is optional (anomalies can occur before login); defaults to 'anon' and is still reported to enable statistics on anonymous anomalies.
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

  /** PvE upgrade: server validates sufficient materials → deduct materials + increment pveUpgrades by 1 → push back (online only). */
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

  // ── Achievements (S9, ACHIEVEMENT_DESIGN): stat milestones → one-time coins. Counts are only written at PvE/PvP authoritative settlement points
  //    (S9-3/S9-6); this section only provides "read definitions + progress" and "claim coins". ──────────────────────────
  /** Achievement definition table + my stats + claimed progress (tier computation is done client-side, §4.1/§6). */
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
   * Claim coins for a specific achievement tier (§4.3): server re-validates stat ≥ threshold + not yet claimed → atomically record claimedTiers (idempotency guard)
   * → commercial grants coins (deterministic orderId prevents double delivery) → mirror wallet back.
   * Record the tier first (sole winner) then deliver coins: concurrent double-taps result in only one recording and one delivery, the other sees "already claimed" and is rejected;
   * crash window (recorded but not delivered) can be compensated later via deterministic orderId — acceptable given the small one-time amount.
   */
  async claimAchievement(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { achId, tier } = req.body as { achId: string; tier: number };
    if (!findAchievement(achId)) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown achievement'));
    }

    // Atomically record the tier: equivalent to validate + $addToSet (already-claimed/not-reached checked inside transform). Success = this call is the sole winner.
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

    // Tier recorded → deliver coins (deterministic orderId, idempotent) + mirror wallet. Amount taken from the definition (the already-validated tier).
    const def = findAchievement(achId)!;
    const coins = def.tiers[tier - 1]?.coins ?? 0;
    const { cols, commercial, now } = this.deps;
    const orderId = `ach:${accountId}:${achId}:${tier}`;
    const g = await commercial.grant({ accountId, amount: coins, reason: 'achievement', orderId });
    if (!g.ok) {
      // Tier recorded but coin delivery failed: return current save (tier is claimed), granted=0; deterministic orderId allows later compensation.
      return ok({ save: recorded.save, granted: 0 });
    }
    const save = await mirrorCoins(cols, accountId, g.coinsAfter, now());

    // Final tier reached and the achievement has an associated title → grant it (idempotent, best-effort)
    if (tier === def.tiers.length && def.titleId) {
      await grantTitleToPlayer(cols, accountId, def.titleId, now()).catch(() => {/* ignore */});
    }

    return ok({ save, granted: coins });
  }

  // ── Retention (B5, RETENTION_DESIGN): monthly check-in calendar + daily tasks. ────────────────────────────────────

  /** Read current retention state (including definition tables; used by the client to render the calendar/task cards). */
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

  /** Claim the next check-in reward for this month (idempotent: already claimed today → 409). */
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
      // Check-in reward: stamina type is written directly to materials; coins type is delivered via commercial service
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
    // Coins reward (milestone) must be delivered via commercial
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

  /** Claim daily task completion coins (idempotent: threshold not reached → 400, already claimed → 409). */
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

  /** Recent match history (ranked / friendly): retrieves a concise summary from archived matches from the current account's perspective. */
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

  /** Retrieve the replay for a specific match (only matches the current account participated in); inline replay takes priority, large matches fall back to replayBlobs (S1-RP). */
  async getMatchReplay(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { cols } = this.deps;
    const roomId = (req.params as { roomId?: string }).roomId;
    if (!roomId) {
      return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'match not found'));
    }
    const doc = await cols.matches.findOne({ roomId });
    // Only matches the current account participated in can be retrieved (prevents unauthorized access to other players' replays).
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

  // ── Social: friends/chat/mail (S6-1/2/3). From P2 onwards: if NW_SOCIALSVC_INTERNAL_URL is configured, route is proxied to socialsvc. ──

  /** Proxy to socialsvc (pass-through JWT + body). socialsvc not configured → 503. */
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

  // ── Social: friends/chat/mail (all proxied to socialsvc from P2 onwards) ──────────────────────────

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

  // ── Social: mail (S6-3). Attachment claiming via claimMail is atomically marked by socialsvc; meta is responsible for actual delivery. ──
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
    // Equipment/card instance snapshots (auction escrow-out): write back to equipmentInv/cardInv by instance.id.
    // Idempotent both ways — claimMailAtomic already gates single-shot claim, and grant* overwrites by id.
    for (const inst of split.equipment) await grantEquipment(cols, now, accountId, inst);
    for (const inst of split.cards) await grantCard(cols, now, accountId, inst);
    const cur = await getOrCreateSave(cols, accountId, now());
    const newSkins = split.skins.filter((s) => !cur.inventory.skins.includes(s));
    const save = await deliverMailGrant(cols, accountId, orderId, newSkins, split.items, coinsAfter, now(), split.materials);
    return ok({ save });
  }

  async sendMail(req: FastifyRequest, reply: FastifyReply) {
    return this.proxySocial(req, reply, '/social/mail/send', req.body);
  }

  // ── economy (S5: meta orchestrates → commercial deducts/randomizes → delivery → mirror push-back) ──────
  /** Economy endpoints are unavailable when commercial is not configured (503). */
  private ensureCommercial(reply: FastifyReply): boolean {
    if (this.deps.commercial.available) return true;
    reply.code(503).send(err(ErrorCode.NOT_IMPLEMENTED, 'commercial service unavailable'));
    return false;
  }

  /** Shop item list (catalog single source of truth: @nw/shared). */
  async getShopItems() {
    const items = SHOP_ITEMS.map((i) => ({
      id: i.id,
      cost: i.cost,
      kind: i.kind,
      grants: i.grants,
    }));
    return ok({ items });
  }

  /** Gacha pool list (entries expanded for client display). Includes active limited pools (GACHA_DESIGN §2.2) with banner metadata. */
  async getGachaPools() {
    const { commercial, now } = this.deps;
    const toView = (p: GachaPoolDef, name?: string): PoolView => {
      const entries = poolEntries(p);
      const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
      return {
        id: p.id,
        costSingle: p.costSingle,
        costTen: p.costTen,
        pityThreshold: p.pityThreshold,
        dupePolicy: p.dupePolicy,
        // Limited pool banner metadata (absent on static pools).
        ...(p.limited
          ? { limited: true, name, featuredLegendary: p.featuredLegendary, endAt: p.endAt }
          : {}),
        // C5-a: each entry includes a probability field (required by Apple 3.1.1).
        entries: entries.map((e) => ({
          ...e,
          probability: totalWeight > 0 ? e.weight / totalWeight : 0,
        })),
      };
    };
    const pools: PoolView[] = GACHA_POOLS.map((p) => toView(p));
    // Append active limited pools (best-effort; if commercial is down the client still gets the static pools).
    if (commercial.available) {
      try {
        const active = await commercial.listActiveLimitedPools(now());
        for (const cfg of active) pools.push(toView(buildLimitedPool(cfg), cfg.name));
      } catch {
        /* best-effort: static pools already returned */
      }
    }
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
    // Delivery: idempotently add skin to inventory + mark as delivered + mirror wallet.
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
    // Static pools validate here; limited pools exist only in commercial (validated there → POOL_UNAVAILABLE).
    if (count !== 1 && count !== 10) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid count'));
    }
    void gachaCost; // cost is authoritative in commercial (computed per pool); here we only validate the draw count.

    const { cols, commercial, now } = this.deps;
    const orderId = randomUUID();
    const draw = await commercial.gachaDraw({ accountId, poolId, count, orderId });
    if (!draw.ok) {
      if (draw.error === 'INSUFFICIENT_FUNDS') {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
      }
      if (draw.error === 'POOL_UNAVAILABLE') {
        return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'pool unavailable'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, draw.error));
    }
    // Delivery is routed by pool type (separate unit card pool, S12-C):
    //  • Unit card pool → results.itemId is a cardKey; added to cardInventory + unitLevels recomputed (no dupe refund —
    //    card collecting naturally accepts all duplicates; duplicate is always false for display only).
    //  • Skin pool → new skins added to inventory.skins (idempotent); duplicate-to-coin conversion deferred to S5 (see economy.ts comment).
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
      // B5: record daily task "open gacha"; merge retention into the returned save so the client immediately sees task completion.
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
    // B5: record daily task "open gacha"; merge retention into the returned save so the client immediately sees task completion.
    await this.bumpRetentionTask(accountId, 'gacha.draw');
    const nextRetention2 = accrueRetentionTask(save.retention, 'gacha.draw', now());
    let saveWithRet2 = nextRetention2 !== save.retention ? { ...save, retention: nextRetention2 } : save;
    // Fate points (§7): reflect the freshly-credited balance immediately (mirror catches up fully on next GET /save).
    if (draw.fateGained > 0) {
      saveWithRet2 = {
        ...saveWithRet2,
        monetization: {
          fatePoints: draw.fatePointsAfter,
          subscriptionExpiry: saveWithRet2.monetization?.subscriptionExpiry ?? 0,
          starterUsed: saveWithRet2.monetization?.starterUsed ?? [],
        },
      };
    }
    return ok({ save: saveWithRet2, results: marked });
  }

  /** Fate Point redemption (GACHA_DESIGN §7): 30 points → one self-chosen past-featured legendary skin. */
  async redeemFate(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { itemId } = req.body as { itemId: string };
    if (!itemId) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing itemId'));

    const { cols, commercial, now } = this.deps;
    const orderId = randomUUID();
    const r = await commercial.redeemFate({ accountId, itemId, orderId });
    if (!r.ok) {
      if (r.error === 'FATE_INSUFFICIENT') {
        return reply.code(402).send(err(ErrorCode.FATE_INSUFFICIENT, 'not enough fate points'));
      }
      if (r.error === 'FATE_INVALID_ITEM') {
        return reply.code(400).send(err(ErrorCode.FATE_INVALID_ITEM, 'not a featured legendary'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, r.error));
    }
    await getOrCreateSave(cols, accountId, now());
    // Deliver the chosen skin idempotently (shared routing), then reflect the new fate balance immediately.
    let save = await deliverOrder(
      cols, commercial, accountId,
      { _id: orderId, kind: 'fate', result: { itemId } },
      r.coinsAfter, null, now(),
    );
    save = {
      ...save,
      monetization: {
        fatePoints: r.fatePointsAfter,
        subscriptionExpiry: save.monetization?.subscriptionExpiry ?? 0,
        starterUsed: save.monetization?.starterUsed ?? [],
      },
    };
    return ok({ save, granted: itemId });
  }

  /** Buy / renew the monthly card (GACHA_DESIGN §5). Real IAP verification is out of scope here (treated as authorized). */
  async monthlyCardBuy(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { cols, commercial, now } = this.deps;
    const orderId = randomUUID();
    const r = await commercial.monthlyCardBuy({ accountId, orderId });
    if (!r.ok) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, r.error));
    const w = await commercial.getWallet(accountId);
    const save = w
      ? await mirrorWalletFrom(cols, accountId, w, now())
      : await getOrCreateSave(cols, accountId, now());
    return ok({ save });
  }

  /** Claim the monthly card's daily coins (GACHA_DESIGN §5): once per UTC day while the subscription is active. */
  async monthlyCardClaim(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { cols, commercial, now } = this.deps;
    const dayKey = adsDayKey(now());
    const r = await commercial.monthlyCardClaim({ accountId, dayKey });
    if (!r.ok) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, r.error));
    const w = await commercial.getWallet(accountId);
    const save = w
      ? await mirrorWalletFrom(cols, accountId, w, now())
      : await getOrCreateSave(cols, accountId, now());
    return ok({ save, claimed: r.claimed });
  }

  /** Buy a starter pack (GACHA_DESIGN §6): starter_draw (rare+ floored 10-pull) or starter_growth (coins + 7-day card). */
  async starterBuy(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { productId } = req.body as { productId: string };
    const { cols, commercial, now } = this.deps;

    // Growth pack: enforce the first-N-days account-age window (best-effort; absent account → allow).
    if (productId === PRODUCT_STARTER_GROWTH) {
      const acct = await cols.accounts.findOne({ _id: accountId });
      if (acct && now() - acct.createdAt > GROWTH_PACK_WINDOW_DAYS * 86400000) {
        return reply.code(403).send(err(ErrorCode.NO_PERMISSION, 'growth pack window closed'));
      }
    }

    const orderId = randomUUID();
    const r = await commercial.starterBuy({ accountId, productId, orderId });
    if (!r.ok) {
      if (r.error === 'ALREADY_PURCHASED') {
        return reply.code(409).send(err(ErrorCode.ALREADY_PURCHASED, 'already purchased'));
      }
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, r.error));
    }

    const before = await getOrCreateSave(cols, accountId, now());
    // Mark new/dup for the reveal BEFORE delivery mutates the skin set (mirrors gachaDraw's convention).
    const marked = markDuplicates(before.inventory.skins, r.results).marked;
    // starter_draw delivers pack items (loot-box routing); starter_growth grants coins/subscription only (no items).
    if (r.results.length > 0) {
      await deliverOrder(
        cols, commercial, accountId,
        { _id: orderId, kind: 'starter', result: { results: r.results, poolId: 'standard' } },
        r.coinsAfter, null, now(),
      );
    }
    // Mirror wallet (coins + monetization: starterUsed / subscription).
    const w = await commercial.getWallet(accountId);
    const save = w
      ? await mirrorWalletFrom(cols, accountId, w, now())
      : await getOrCreateSave(cols, accountId, now());
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

    // 30-minute interval gate (C2).
    const intervalOk = await checkAdInterval(cols, accountId, dayKey, ts, ADS_MIN_INTERVAL_MS);
    if (!intervalOk) {
      return reply.code(429).send(err(ErrorCode.DAILY_CAP_REACHED, 'ad cooldown not elapsed'));
    }

    // Daily cap (C2).
    const allowed = await bumpAdsCap(cols, accountId, dayKey, ADS_DAILY_CAP, ts);
    if (!allowed) {
      return reply.code(429).send(err(ErrorCode.DAILY_CAP_REACHED, 'daily ad cap reached'));
    }

    // Token uniqueness (C2): hash stored in DB; replays are rejected.
    const tokenHash = hashAdToken(adToken);
    const unique = await recordAdToken(cols, tokenHash, accountId, ts);
    if (!unique) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'duplicate adToken'));
    }

    // Platform signature verification (C2): performed for all platforms except dev.
    const plat = platform ?? 'dev';
    if (plat !== 'dev') {
      const sigOk = verifyAdPlatformToken(plat, adToken);
      if (!sigOk) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid ad signature'));
    }

    const credit = await commercial.adsCredit({ accountId, amount: ADS_REWARD_COINS, dayKey });
    if (!credit.ok) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, credit.error));
    const save = await mirrorCoins(cols, accountId, credit.coinsAfter, now());
    // B6: record event task "ad.watch" (best-effort).
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
    // receiptId = unique platform receipt id (idempotency key). The dev stub uses platform:receipt; real channel integration uses the platform transaction id.
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

  /** Promo code redemption (B-PROMO): validate → grant coins → push back save. */
  async redeemPromoCode(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { code } = req.body as { code: string };
    if (!code || typeof code !== 'string') {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'code required'));
    }
    const { cols, commercial, now } = this.deps;
    const v = await commercial.promoRedeem({ accountId, code });
    if (!v.ok) {
      const statusMap: Record<string, number> = {
        PROMO_NOT_FOUND: 404,
        PROMO_EXPIRED: 400,
        PROMO_EXHAUSTED: 400,
        PROMO_ALREADY_USED: 400,
      };
      const status = statusMap[v.error] ?? 400;
      return reply.code(status).send(err(ErrorCode.BAD_REQUEST, v.error));
    }
    const save = await mirrorCoins(cols, accountId, v.coinsAfter, now());
    return ok({ coinsAfter: v.coinsAfter, coinsGranted: v.coinsGranted, save });
  }

  /**
   * Equipment crafting (E2, EQUIPMENT_DESIGN §4/§7): deduct stationery materials → roll one +0 base equipment → store (300-item cap).
   * idempotencyKey is idempotent (client-generated): replay returns the first result without re-deducting materials or re-rolling.
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
   * Equipment enhancement (E3, EQUIPMENT_DESIGN §6): server rolls the dice (success rate table) → deduct materials + coins (commercial is authoritative) →
   * success increments level by 1, failure does not downgrade. idempotencyKey is idempotent (roll and deduction bound to key; replay returns the first result).
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
   * Equipment salvage (E3, EQUIPMENT_DESIGN §6.3): +0~4 items return 70% of crafting materials and are removed from inventory; +5 items rejected, equipped/locked items rejected.
   * Batch operation + idempotencyKey is idempotent (replay returns the first refund).
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
   * Equip / unequip equipment (E4, EQUIPMENT_DESIGN §3.4): validate slot match → write gear into the target CardInstance.
   * instanceId=null to unequip. cardInstanceId identifies which card's gear slot is written. Naturally idempotent.
   */
  async equipEquipment(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { slot, instanceId, cardInstanceId } = req.body as {
      slot: string;
      instanceId: string | null;
      cardInstanceId: string;
    };
    const { cols, now } = this.deps;
    const r = await equipEquipment(cols, now, accountId, slot, instanceId ?? null, cardInstanceId);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
    return ok({ save: r.save });
  }

  /**
   * Equipment reforging (E6, EQUIPMENT_DESIGN §7.8): consume a lower-tier material of the same slot, keep the primary stat, re-roll secondary stats.
   * fine/rare/epic can be reforged; material must be the same slot and exactly one tier lower. idempotencyKey is idempotent.
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

  // ── CC-2 Hero Roster ─────────────────────────────────────────────────────────────────

  /**
   * Feed material cards into a target card to gain XP and level up (CHARACTER_CARDS_DESIGN §3.3, CC-2).
   * Same-faction required; locked materials rejected; idempotencyKey prevents double-consumption.
   */
  async cardsFeed(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { targetId, materialIds, idempotencyKey } = req.body as {
      targetId: string;
      materialIds: string[];
      idempotencyKey: string;
    };
    const { cols, now } = this.deps;
    const r = await feedCards(cols, now, accountId, targetId, materialIds, idempotencyKey);
    if ('error' in r) return reply.code(ERROR_HTTP_STATUS[r.code] ?? 400).send(err(r.code as ErrorCode, r.error));
    return ok({ card: r.card, levelsGained: r.levelsGained, save: r.save });
  }

  // ── S11 Leaderboard / Battle Pass ──────────────────────────────────────────────────────

  /** Top-100 ladder leaderboard (current season ELO descending, S11 §5). */
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

  /** Purchase the current season's battle pass (600 coins, S11 §9). */
  async buyBattlePass(req: FastifyRequest, reply: FastifyReply) {
    if (!this.ensureCommercial(reply)) return;
    const accountId = accountIdOf(req);
    const { cols, commercial, now } = this.deps;

    // Confirm/create battle pass data first (lazy creation: initialized on first purchase this season).
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

    // Atomically write hasPass=true (optimistic lock).
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

  /** Claim a battle pass reward (free track or paid track, S11 §9). */
  async claimBattlePass(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { track, level } = req.body as { track: 'free' | 'paid'; level: number };
    const { cols, commercial, now } = this.deps;

    // Atomic validate + record claim (optimistic lock prevents double-tap). Material rewards are written to save.materials in the same transaction.
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
    // If the reward includes coins, mirror the wallet after delivery via commercial.
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

  // ── B6 Limited-time events ───────────────────────────────────────────────────────────

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
    const socialsvc = this.deps.socialsvc ?? nullMetaSocialsvcClient;
    const result = await claimEventReward(cols, accountId, eventId, rewardId, now(), commercial, socialsvc);
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

  // ── S10 Title endpoints (L2-2, TITLE_DESIGN): player-side read of granted titles + selection of active display title. ────────────
  // Storage reuses save.titles[] / save.equipped.title (server-authoritative; PUT /save cannot write these two fields);
  // title source/seasonNo are derived from the titleId naming convention (parseTitleId, same source as client display); grant time is not stored.

  /** Read all titles granted to the current account (including derived source/seasonNo) + currently equipped title. */
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
   * Select the active display title → write save.equipped.title → push back the full save.
   * Only granted titles are allowed; an empty string titleId is treated as unequipping (clears the equipped title).
   */
  async equipTitle(req: FastifyRequest, reply: FastifyReply) {
    const accountId = accountIdOf(req);
    const { titleId } = req.body as { titleId?: string };
    const out = await this.mutateSave(accountId, (s) => {
      const owned = s.titles ?? [];
      // empty string = unequip display title
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

  // Analytics endpoints in openapi.yml are stubs here — analyticsvc is a separate process.
  // Defined so MetaService satisfies MetaHandlers (ADR-023 compile-time check); always returns 501.
  async getAnalyticsConfig(_req: FastifyRequest, reply: FastifyReply) {
    return reply.code(501).send({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'analytics config not served by metaserver' } });
  }

  async postAnalyticsEvents(_req: FastifyRequest, reply: FastifyReply) {
    return reply.code(501).send({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'analytics events not served by metaserver' } });
  }
}
