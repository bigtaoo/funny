// authOAuth/authBind (2026-08-11 split of service/auth.ts — see auth.ts's shell comment for the
// overall split rationale/module map).
//
// 2026-08-11 ctx-bind cleanup (see base.ts's header and credential.ts's header for the same pattern):
// the MetaCore-derived half of `OAuthCtx` (`deps`/`rejectIfBanned`/`gatewayField`) collapses to a
// single `core: MetaCore` field; `oauth`/`allowAuthAttempt` (genuinely AuthService-only) stay separate.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok, signToken } from '@nw/shared';
import { regionFromAcceptLanguage } from '@nw/shared';
import { validateLoginId, validatePassword } from '@nw/shared';
import { bindOAuth, bindPassword, ensurePublicId, resolveByOAuth } from '../../accounts.js';
import { OAuthError, type OAuthProvider, type OAuthService } from '../../oauth.js';
import { accountIdOf, type MetaCore } from '../base.js';
import { restoreIfWithinGrace, maybeGrantStarterCards } from './helpers.js';

export interface OAuthCtx {
  core: MetaCore;
  oauth: OAuthService;
  allowAuthAttempt: (req: FastifyRequest, now: number) => Promise<boolean>;
}

/**
 * OAuth third-party login (SA-2): authorization code flow, initially supporting Google.
 * The server exchanges the code for an access_token → retrieves sub → upserts the account.
 */
export async function authOAuthHandler(ctx: OAuthCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!(await ctx.allowAuthAttempt(req, ctx.core.deps.now()))) {
    return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many auth attempts, try later'));
  }
  const { provider, code, redirectUri } = req.body as {
    provider: string;
    code: string;
    redirectUri: string;
  };
  if (!ctx.oauth.supports(provider)) {
    return reply
      .code(400)
      .send(err(ErrorCode.OAUTH_FAILED, `unsupported or unconfigured OAuth provider: ${provider}`));
  }
  let sub: string;
  try {
    const result = await ctx.oauth.exchangeCode(provider as OAuthProvider, code, redirectUri);
    sub = result.sub;
  } catch (e) {
    const msg = e instanceof OAuthError ? e.message : 'OAuth exchange failed';
    return reply.code(400).send(err(ErrorCode.OAUTH_FAILED, msg));
  }
  const region = regionFromAcceptLanguage(req.headers['accept-language']);
  const { accountId, isNew, isAnonymous, displayName } = await resolveByOAuth(
    ctx.core.deps.cols,
    provider,
    sub,
    ctx.core.deps.now(),
    region,
  );
  await restoreIfWithinGrace(ctx.core.deps, accountId);
  if (await ctx.core.rejectIfBanned(ctx.core.deps.cols, accountId, reply)) return;
  const token = signToken(accountId, ctx.core.deps.jwt);
  const publicId = await ensurePublicId(ctx.core.deps.cols, accountId);
  await maybeGrantStarterCards(ctx.core.deps, accountId, isNew);
  return ok({
    token,
    accountId,
    isNew,
    isAnonymous,
    publicId,
    ...(displayName ? { displayName } : {}),
    ...ctx.core.gatewayField,
  });
}

/**
 * Bind a credential to the current account (SA-2): convert anonymous account to registered + bind multiple credentials.
 * method='oauth': same as authOAuth, but binds to the existing account identified by the JWT (no new account created).
 * method='password': assigns a password to the account (idempotent if a password already exists).
 * If the target credential already belongs to another account → ALREADY_BOUND.
 */
export async function authBindHandler(ctx: OAuthCtx, req: FastifyRequest, reply: FastifyReply) {
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
    if (!ctx.oauth.supports(provider)) {
      return reply
        .code(400)
        .send(err(ErrorCode.OAUTH_FAILED, `unsupported or unconfigured OAuth provider: ${provider}`));
    }
    let sub: string;
    try {
      const result = await ctx.oauth.exchangeCode(provider as OAuthProvider, code, redirectUri);
      sub = result.sub;
    } catch (e) {
      const msg = e instanceof OAuthError ? e.message : 'OAuth exchange failed';
      return reply.code(400).send(err(ErrorCode.OAUTH_FAILED, msg));
    }
    const bindResult = await bindOAuth(ctx.core.deps.cols, accountId, provider, sub);
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

    const bindResult = await bindPassword(ctx.core.deps.cols, accountId, loginId, password);
    if (bindResult.kind === 'login_id_taken') {
      return reply.code(409).send(err(ErrorCode.LOGIN_ID_TAKEN, 'loginId already registered to another account'));
    }
    return ok({ ok: true, isAnonymous: false });
  }

  return reply.code(400).send(err(ErrorCode.BAD_REQUEST, `unknown bind method: ${method}`));
}
