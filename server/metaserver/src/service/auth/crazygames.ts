// authCrazyGames (RETENTION_LAUNCH_PLAN.md §1.1/§3.1) — CrazyGames portal SSO. Same shell shape as
// authWx/authDevice (credential.ts): verify a third-party credential, resolve-or-create an account,
// sign our own token. The one real difference from authWx/authDevice is that the resolved account is
// treated as a RECOVERABLE credential (isAnonymous:false, via resolveByOAuth) — a CrazyGames account
// is exactly as durable as Google/Apple OAuth, not a bare device id.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok, signToken } from '@nw/shared';
import { regionFromAcceptLanguage } from '@nw/shared';
import { resolveByOAuth, ensurePublicId } from '../../accounts.js';
import { CrazyGamesAuthError, type CrazyGamesAuthConfig, type CrazyGamesTokenPayload } from '../../crazygamesAuth.js';
import type { MetaCore } from '../base.js';
import { restoreIfWithinGrace, maybeGrantStarterCards } from './helpers.js';

/** `'crazygames'` is not in `OAuthProvider` (google-only, oauth.ts) on purpose — this is a distinct
 *  verification mechanism (a portal-issued JWT, not an authorization-code exchange), so it does not
 *  go through OAuthService/authOAuthHandler. `resolveByOAuth`'s `provider` param is a plain string,
 *  so reusing it here (same account-durability semantics as Google/Apple) needs no changes there. */
const CRAZYGAMES_PROVIDER = 'crazygames';

export interface CrazyGamesCtx {
  core: MetaCore;
  config: CrazyGamesAuthConfig | undefined;
  /** Injected (not imported directly) so unit tests can drive every outcome without a real RSA
   *  keypair or network call — same reasoning as OAuthCtx.oauth in oauthBind.ts. The real one
   *  (service/auth.ts) is `verifyCrazyGamesToken` from ../../crazygamesAuth.js. */
  verify: (token: string, cfg: CrazyGamesAuthConfig) => Promise<CrazyGamesTokenPayload>;
  allowAuthAttempt: (req: FastifyRequest, now: number) => Promise<boolean>;
}

export async function authCrazyGamesHandler(ctx: CrazyGamesCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!(await ctx.allowAuthAttempt(req, ctx.core.deps.now()))) {
    return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many auth attempts, try later'));
  }
  if (!ctx.config) {
    return reply.code(400).send(err(ErrorCode.OAUTH_FAILED, 'CrazyGames SSO not configured (NW_CRAZYGAMES_GAME_ID missing)'));
  }
  const { token } = req.body as { token: string };
  let userId: string;
  try {
    const payload = await ctx.verify(token, ctx.config);
    userId = payload.userId;
  } catch (e) {
    const msg = e instanceof CrazyGamesAuthError ? e.message : 'CrazyGames token verification failed';
    return reply.code(400).send(err(ErrorCode.OAUTH_FAILED, msg));
  }

  const region = regionFromAcceptLanguage(req.headers['accept-language']);
  const { accountId, isNew, isAnonymous, displayName } = await resolveByOAuth(
    ctx.core.deps.cols,
    CRAZYGAMES_PROVIDER,
    userId,
    ctx.core.deps.now(),
    region,
  );
  await restoreIfWithinGrace(ctx.core.deps, accountId);
  if (await ctx.core.rejectIfBanned(ctx.core.deps.cols, accountId, reply)) return;
  const signedToken = signToken(accountId, ctx.core.deps.jwt);
  const publicId = await ensurePublicId(ctx.core.deps.cols, accountId);
  await maybeGrantStarterCards(ctx.core.deps, accountId, isNew);
  return ok({
    token: signedToken,
    accountId,
    isNew,
    isAnonymous,
    publicId,
    ...(displayName ? { displayName } : {}),
    ...ctx.core.gatewayField,
  });
}
