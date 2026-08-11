// Auth + profile handlers (SA-2 / S0 / S4-3 / C5): anonymous/device/wx/password/oauth login,
// credential binding, password change, account soft-delete, GDPR consent, display-name rename.
//
// Split into independent function modules (2026-08-11, same "薄装配壳 + 关注点分层" form as
// pve.ts/liveops.ts — see claudedocs/server.md's split-priority doc). Every handler only ever needs
// `this.core.deps` plus a handful of MetaCore methods (rejectIfBanned/ensureCommercial/gatewayField) or
// this class's own private rate-limit checks — never anything from *another* domain mixin.
//
// 2026-08-11 ctx-bind cleanup (see base.ts's header): now that MetaCore's members are plain public
// methods, credential.ts/oauthBind.ts/profile.ts's ctx objects no longer flatten+bind individual
// MetaCore members — `profileRenameHandler` takes `this.core` directly, and
// credential.ts/oauthBind.ts's `CredentialCtx`/`OAuthCtx` collapse their MetaCore-derived fields into
// one `core: MetaCore` field, keeping only the genuinely AuthService-only extras
// (`allowAuthAttempt`/`oauth`) as separate ctx fields (still `.bind(this)`-ed, since those really are
// this class's own private state, not a MetaCore passthrough). No behavior change: every method body
// was moved verbatim.
// - auth/helpers.ts:        restoreIfWithinGrace/maybeGrantStarterCards — deps-only, shared by every handler below
// - auth/credential.ts:     authWx/authDevice/authRegister/authLogin/authPasswordChange
// - auth/oauthBind.ts:      authOAuth/authBind
// - auth/accountLifecycle.ts: deleteAccount/cancelAccountDeletion/recordGdprConsent
// - auth/profile.ts:        profileRename
// - auth/support.ts:        submitAppeal/submitFeedback
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FEEDBACK_RATE_LIMIT_PER_DAY } from '@nw/shared';
import {
  authWxHandler,
  authDeviceHandler,
  authRegisterHandler,
  authLoginHandler,
  authPasswordChangeHandler,
} from './auth/credential.js';
import { authOAuthHandler, authBindHandler } from './auth/oauthBind.js';
import { deleteAccountHandler, cancelAccountDeletionHandler, recordGdprConsentHandler } from './auth/accountLifecycle.js';
import { profileRenameHandler } from './auth/profile.js';
import { submitAppealHandler, submitFeedbackHandler } from './auth/support.js';
import { createOAuthService } from '../oauth.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { createRateLimiter, type RateLimiter, type MetaCore } from './base.js';

type AuthHandlers = Pick<
  MetaHandlers,
  | 'authWx' | 'authDevice' | 'authRegister' | 'authLogin' | 'authPasswordChange'
  | 'deleteAccount' | 'cancelAccountDeletion' | 'recordGdprConsent' | 'authOAuth' | 'authBind' | 'profileRename'
  | 'submitAppeal' | 'submitFeedback'
>;

export class AuthService {
  private readonly oauth = createOAuthService();

  /**
   * Login/register IP rate limit (S4-3): at most authRateLimit auth attempts per IP within 15 minutes
   * (prevents brute-force credential stuffing). Redis-backed when configured (2026-07-27, precise across
   * instances); in-process fallback otherwise — see createRateLimiter/SlidingRateLimiter in base.ts.
   * Disabled when authRateLimit=0 (for CI/tests).
   */
  private readonly authRate: RateLimiter;

  /** Feedback submission rate limit (SERVER_API.md §2.13): per-account, not per-IP — a public feedback
   *  box is meant to be usable behind shared/NAT IPs, and the abuse surface here is one account spamming
   *  text, not credential stuffing (that's authRate's job). Redis-backed when configured, in-process fallback otherwise. */
  private readonly feedbackRate: RateLimiter;

  constructor(private readonly core: MetaCore) {
    // Built in the constructor body (not as field initializers) so `this.core` is unambiguously assigned
    // before either rate limiter reads `this.core.deps` — field-initializer evaluation order relative to
    // a parameter-property assignment is exactly the kind of subtlety not worth relying on here.
    this.authRate = this.core.deps.authRateLimit > 0
      ? createRateLimiter(this.core.deps.redis, 'auth', this.core.deps.authRateLimit, 15 * 60 * 1000)
      : { allow: async () => true };
    this.feedbackRate = createRateLimiter(this.core.deps.redis, 'feedback', FEEDBACK_RATE_LIMIT_PER_DAY, 24 * 60 * 60 * 1000);
  }

    private async allowAuthAttempt(req: FastifyRequest, now: number): Promise<boolean> {
      const ip = req.ip ?? 'unknown';
      return this.authRate.allow(ip, now);
    }

    async authWx(req: FastifyRequest, reply: FastifyReply) {
      return authWxHandler({ core: this.core, allowAuthAttempt: this.allowAuthAttempt.bind(this) }, req, reply);
    }

    async authDevice(req: FastifyRequest, reply: FastifyReply) {
      return authDeviceHandler({ core: this.core, allowAuthAttempt: this.allowAuthAttempt.bind(this) }, req, reply);
    }

    async authRegister(req: FastifyRequest, reply: FastifyReply) {
      return authRegisterHandler({ core: this.core, allowAuthAttempt: this.allowAuthAttempt.bind(this) }, req, reply);
    }

    async authLogin(req: FastifyRequest, reply: FastifyReply) {
      return authLoginHandler({ core: this.core, allowAuthAttempt: this.allowAuthAttempt.bind(this) }, req, reply);
    }

    async authPasswordChange(req: FastifyRequest, reply: FastifyReply) {
      return authPasswordChangeHandler(this.core.deps, req, reply);
    }

    async authOAuth(req: FastifyRequest, reply: FastifyReply) {
      return authOAuthHandler(
        { core: this.core, oauth: this.oauth, allowAuthAttempt: this.allowAuthAttempt.bind(this) },
        req,
        reply,
      );
    }

    async authBind(req: FastifyRequest, reply: FastifyReply) {
      return authBindHandler(
        { core: this.core, oauth: this.oauth, allowAuthAttempt: this.allowAuthAttempt.bind(this) },
        req,
        reply,
      );
    }

    async deleteAccount(req: FastifyRequest) {
      return deleteAccountHandler(this.core.deps, req);
    }

    async cancelAccountDeletion(req: FastifyRequest, reply: FastifyReply) {
      return cancelAccountDeletionHandler(this.core.deps, req, reply);
    }

    async recordGdprConsent(req: FastifyRequest) {
      return recordGdprConsentHandler(this.core.deps, req);
    }

    async profileRename(req: FastifyRequest, reply: FastifyReply) {
      return profileRenameHandler(this.core, req, reply);
    }

    async submitAppeal(req: FastifyRequest, reply: FastifyReply) {
      return submitAppealHandler(this.core.deps, req, reply);
    }

    async submitFeedback(req: FastifyRequest, reply: FastifyReply) {
      return submitFeedbackHandler(this.core.deps, this.feedbackRate, req, reply);
    }
}
