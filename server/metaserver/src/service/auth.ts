// Auth + profile handlers (SA-2 / S0 / S4-3 / C5): anonymous/device/wx/password/oauth login,
// credential binding, password change, account soft-delete, GDPR consent, display-name rename.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok, signToken } from '@nw/shared';
import { regionFromAcceptLanguage, censorChat } from '@nw/shared';
import { validateLoginId, validatePassword, validateDisplayName } from '@nw/shared';
import { RENAME_COST } from '@nw/shared';
import { APPEAL_REASON_MAX } from '@nw/shared';
import { CARD_DEFS } from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import {
  bindOAuth,
  bindPassword,
  changePassword,
  ensurePublicId,
  exchangeWxCode,
  hasFreeRename,
  loginWithPassword,
  registerWithPassword,
  resolveByDevice,
  resolveByOAuth,
  resolveByOpenid,
  setDisplayName,
} from '../accounts.js';
import { createOAuthService, OAuthError, type OAuthProvider } from '../oauth.js';
import { grantCards } from '../cards.js';
import { mirrorCoins } from '../economy.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, clientPlatformOf, createRateLimiter, type RateLimiter, type Constructor, type MetaBaseCtor } from './base.js';

type AuthHandlers = Pick<
  MetaHandlers,
  | 'authWx' | 'authDevice' | 'authRegister' | 'authLogin' | 'authPasswordChange'
  | 'deleteAccount' | 'cancelAccountDeletion' | 'recordGdprConsent' | 'authOAuth' | 'authBind' | 'profileRename'
  | 'submitAppeal'
>;

/** C5-b account soft-delete grace period: POST /account/cancel-deletion is only honored within this window. */
const ACCOUNT_DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function AuthMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<AuthHandlers> {
  return class extends Base {
    private readonly oauth = createOAuthService();

    /**
     * Login/register IP rate limit (S4-3): at most authRateLimit auth attempts per IP within 15 minutes
     * (prevents brute-force credential stuffing). Redis-backed when configured (2026-07-27, precise across
     * instances); in-process fallback otherwise — see createRateLimiter/SlidingRateLimiter in base.ts.
     * Disabled when authRateLimit=0 (for CI/tests).
     */
    private readonly authRate: RateLimiter =
      this.deps.authRateLimit > 0
        ? createRateLimiter(this.deps.redis, 'auth', this.deps.authRateLimit, 15 * 60 * 1000)
        : { allow: async () => true };

    private async allowAuthAttempt(req: FastifyRequest, now: number): Promise<boolean> {
      const ip = req.ip ?? 'unknown';
      return this.authRate.allow(ip, now);
    }

    /** Grant lichuang/chenshou/suyuan to a brand-new account (CHARACTER_CARDS_DESIGN §4). No-op if account already has cards. */
    private async maybeGrantStarterCards(accountId: string, isNew: boolean): Promise<void> {
      if (!isNew) return;
      const { cols, now } = this.deps;
      const save = await getOrCreateSave(cols, accountId, now());
      if (save.cardInvCount > 0) return;
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
      if (!(await this.allowAuthAttempt(req, this.deps.now()))) {
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

      // CONTENT_MODERATION_DESIGN.md CM5: a user-supplied displayName at registration is just as
      // persistent/public as one set via profileRename, but until now this path skipped both length
      // validation and censorChat entirely — an unfiltered name went straight into registerWithPassword.
      // Same reject-on-hit policy as profileRename (display names are long-lived, not ephemeral chat).
      if (displayName !== undefined) {
        const nameErr = validateDisplayName(displayName);
        if (nameErr) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, nameErr));
        if (censorChat(displayName.trim(), region, this.deps.wordlists ?? undefined).hit) {
          return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'display name contains disallowed words'));
        }
      }

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
      if (!(await this.allowAuthAttempt(req, this.deps.now()))) {
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
     * confirmToken is persisted alongside deletedAt (not just minted and discarded) so
     * POST /account/cancel-deletion can verify it and undo the soft-delete within the grace period
     * (comm-audit-2026-07-27 finding B14 — previously the token was generated, returned, and never
     * stored anywhere, and no cancellation endpoint existed at all).
     */
    async deleteAccount(req: FastifyRequest) {
      const accountId = accountIdOf(req);
      const { cols, now, accountCache } = this.deps;
      const confirmToken = randomUUID();
      await cols.accounts.updateOne(
        { _id: accountId },
        { $set: { deletedAt: now(), deletionConfirmToken: confirmToken } },
      );
      accountCache.invalidateBanStatus(accountId);
      return ok({ confirmToken });
    }

    /**
     * C5-b: undo a pending soft-delete within the 7-day grace period. Requires the confirmToken
     * minted by DELETE /account; wrong token or an elapsed grace period both reject with
     * DELETION_TOKEN_INVALID (not distinguished in the response — same reasoning as a login failure
     * not distinguishing "wrong password" from "no such user", avoiding a token-guessing oracle).
     */
    async cancelAccountDeletion(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { confirmToken } = req.body as { confirmToken?: string };
      const { cols, now, accountCache } = this.deps;
      const doc = await cols.accounts.findOne(
        { _id: accountId },
        { projection: { deletedAt: 1, deletionConfirmToken: 1 } },
      );
      if (!doc?.deletedAt) {
        return reply.code(400).send(err(ErrorCode.ACCOUNT_NOT_DELETED, 'account is not pending deletion'));
      }
      const withinGrace = now() - doc.deletedAt < ACCOUNT_DELETE_GRACE_MS;
      if (!withinGrace || !confirmToken || confirmToken !== doc.deletionConfirmToken) {
        return reply.code(400).send(err(ErrorCode.DELETION_TOKEN_INVALID, 'invalid token or grace period elapsed'));
      }
      await cols.accounts.updateOne(
        { _id: accountId },
        { $unset: { deletedAt: '', deletionConfirmToken: '' } },
      );
      // Undo-deletion also writes accounts.deletedAt (via $unset) — must invalidate the same cache
      // deleteAccount does, otherwise the account stays rejected as "still deleted" for the rest of
      // the cache TTL after a successful cancel-deletion (accountCache.ts's BanStatus caches deletedAt).
      accountCache.invalidateBanStatus(accountId);
      return ok({ ok: true });
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
      if (!(await this.allowAuthAttempt(req, this.deps.now()))) {
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

    /**
     * Change display name. The first rename for a player who never deliberately chose a name (guests,
     * WeChat/OAuth, or password users who skipped the name field — their current name is a system-assigned
     * default) is **free**; every rename after that costs RENAME_COST coins. Requires login; the paid path
     * additionally requires the commercial service.
     */
    async profileRename(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { displayName } = req.body as { displayName: string };
      const nameErr = validateDisplayName(displayName);
      if (nameErr) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, nameErr));
      const name = displayName.trim();

      // UGC governance (COMPLIANCE_GLOBAL.md §7): the design doc has long said displayName rename "should go
      // through the same filter" as private chat, but this handler never actually called it — displayName is
      // persistent and shown to every other player who sees this account, unlike an ephemeral chat message, so
      // (unlike censorChat's mask-and-deliver policy for chat) a hit here REJECTS the rename outright rather
      // than saving a masked "****" as a permanent name. Checked before the paid path spends any coins.
      const region = regionFromAcceptLanguage(req.headers['accept-language']);
      if (censorChat(name, region, this.deps.wordlists ?? undefined).hit) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'display name contains disallowed words'));
      }

      const { cols, commercial, now } = this.deps;

      // One-time free rename for players who still carry a default name (never chose one).
      if (await hasFreeRename(cols, accountId)) {
        await setDisplayName(cols, accountId, name); // also marks nameChosen → subsequent renames are paid
        const save = await getOrCreateSave(cols, accountId, now());
        return ok({ save, displayName: name, freeRename: false });
      }

      if (!this.ensureCommercial(reply)) return;
      const orderId = randomUUID();
      const charge = await commercial.spend({ accountId, amount: RENAME_COST, reason: 'rename', orderId, clientPlatform: clientPlatformOf(req) });
      if (!charge.ok) {
        if (charge.error === 'INSUFFICIENT_FUNDS') {
          return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
        }
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, charge.error));
      }
      await setDisplayName(cols, accountId, name);
      const save = await mirrorCoins(cols, accountId, charge.coinsAfter, now());
      return ok({ save, displayName: name, freeRename: false });
    }

    /**
     * Submit an appeal against the account's currently active mute/temp-ban/ban (CONTENT_MODERATION_DESIGN.md
     * CM10). Only allowed while an enforcement is actually active (a healed/expired mute or a long-past temp
     * ban has nothing left to appeal), and only one open appeal at a time per account (prevents spam re-submits
     * while the first is still pending review).
     */
    async submitAppeal(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { reason } = req.body as { reason: string };
      const trimmed = reason.trim();
      if (!trimmed) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'reason required'));

      const { cols, now } = this.deps;
      const existingOpen = await cols.appeals.findOne({ accountId, status: 'open' });
      if (existingOpen) {
        return reply.code(409).send(err(ErrorCode.ALREADY_REQUESTED, 'an appeal is already pending for this account'));
      }

      const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { flags: 1 } });
      const nowMs = now();
      const flags = doc?.flags;
      const bannedUntilActive = !!flags?.bannedUntil && flags.bannedUntil > nowMs;
      const mutedUntilActive = !!flags?.mutedUntil && flags.mutedUntil > nowMs;
      if (!flags?.banned && !bannedUntilActive && !mutedUntilActive) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'no active enforcement to appeal'));
      }

      try {
        await cols.appeals.insertOne({
          _id: randomUUID(),
          accountId,
          reason: trimmed.slice(0, APPEAL_REASON_MAX),
          enforcementSnapshot: {
            ...(flags?.banned ? { banned: true } : {}),
            ...(bannedUntilActive ? { bannedUntil: flags!.bannedUntil } : {}),
            ...(mutedUntilActive ? { mutedUntil: flags!.mutedUntil } : {}),
            ...(typeof flags?.reputationScore === 'number' ? { reputationScore: flags.reputationScore } : {}),
          },
          status: 'open',
          createdAt: nowMs,
        });
      } catch (e) {
        // Unique partial index on {accountId, status:'open'} (mongo.ts) is the atomic backstop behind the
        // findOne check above: two concurrent submits from the same account can both pass that read, but
        // only one insertOne wins here.
        if ((e as { code?: number }).code === 11000) {
          return reply.code(409).send(err(ErrorCode.ALREADY_REQUESTED, 'an appeal is already pending for this account'));
        }
        throw e;
      }
      return ok({ ok: true });
    }
  };
}
