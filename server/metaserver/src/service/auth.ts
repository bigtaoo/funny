// Auth + profile handlers (SA-2 / S0 / S4-3 / C5): anonymous/device/wx/password/oauth login,
// credential binding, password change, account soft-delete, GDPR consent, display-name rename.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok, signToken } from '@nw/shared';
import { regionFromAcceptLanguage } from '@nw/shared';
import { validateLoginId, validatePassword, validateDisplayName } from '@nw/shared';
import { RENAME_COST } from '@nw/shared';
import { CARD_DEFS } from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import {
  bindOAuth,
  bindPassword,
  changePassword,
  ensurePublicId,
  exchangeWxCode,
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
import { accountIdOf, SlidingRateLimiter, type Constructor, type MetaBaseCtor } from './base.js';

type AuthHandlers = Pick<
  MetaHandlers,
  | 'authWx' | 'authDevice' | 'authRegister' | 'authLogin' | 'authPasswordChange'
  | 'deleteAccount' | 'recordGdprConsent' | 'authOAuth' | 'authBind' | 'profileRename'
>;

export function AuthMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<AuthHandlers> {
  return class extends Base {
    private readonly oauth = createOAuthService();

    /**
     * Login/register IP rate limit (S4-3): at most authRateLimit auth attempts per IP within 15 minutes (prevents brute-force credential stuffing).
     * In-process approximation (per-instance when scaled out — sufficient to defend against single-machine attacks; precise global limiting requires Redis).
     * Disabled when authRateLimit=0 (for CI/tests).
     */
    private readonly authRate: { allow(key: string, now: number): boolean } =
      this.deps.authRateLimit > 0
        ? new SlidingRateLimiter(this.deps.authRateLimit, 15 * 60 * 1000)
        : { allow: () => true };

    private allowAuthAttempt(req: FastifyRequest, now: number): boolean {
      const ip = req.ip ?? 'unknown';
      return this.authRate.allow(ip, now);
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
  };
}
