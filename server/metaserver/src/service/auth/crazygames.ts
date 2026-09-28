// authCrazyGames (RETENTION_LAUNCH_PLAN.md §1.1/§3.1) — CrazyGames portal SSO. Same shell shape as
// authWx/authDevice (credential.ts): verify a third-party credential, resolve-or-create an account,
// sign our own token. The one real difference from authWx/authDevice is that the resolved account is
// treated as a RECOVERABLE credential (isAnonymous:false, via resolveByOAuth) — a CrazyGames account
// is exactly as durable as Google/Apple OAuth, not a bare device id.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Collections } from '@nw/shared';
import {
  ErrorCode, err, ok, signToken, verifyToken, isAnonymousAccount, isAllowedPlatformAvatarUrl,
  validateDisplayName, MAX_DISPLAY_NAME_LEN,
} from '@nw/shared';
import { regionFromAcceptLanguage } from '@nw/shared';
import { resolveByOAuth, ensurePublicId, bindOAuth } from '../../accounts.js';
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
  const { token, guestToken } = req.body as { token: string; guestToken?: string };
  let payload: CrazyGamesTokenPayload;
  try {
    payload = await ctx.verify(token, ctx.config);
  } catch (e) {
    const msg = e instanceof CrazyGamesAuthError ? e.message : 'CrazyGames token verification failed';
    return reply.code(400).send(err(ErrorCode.OAUTH_FAILED, msg));
  }

  const userId = payload.userId;
  const cols = ctx.core.deps.cols;

  const region = regionFromAcceptLanguage(req.headers['accept-language']);
  // A guest who has been playing on a device account and then signs into CrazyGames keeps their
  // progress: the portal identity is attached to that guest account instead of opening a new one
  // (the portal's account-integration rule; CRAZYGAMES_LAUNCH.md §4.1). Only when this CrazyGames
  // user has no account yet — a returning CrazyGames user always gets their own account back.
  const linked = await linkToGuest(ctx, guestToken, userId);
  const { accountId, isNew, isAnonymous } = linked
    ? { accountId: linked, isNew: false, isAnonymous: false }
    : await resolveByOAuth(cols, CRAZYGAMES_PROVIDER, userId, ctx.core.deps.now(), region);
  const displayName = await syncPortalProfile(cols, accountId, payload);
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

/**
 * The account behind `guestToken` when it is a pure device guest and this CrazyGames user is not bound
 * anywhere yet — and binds it. Anything else (no/invalid token, an account that already has a
 * recoverable credential, the CrazyGames user already owning an account, a racing bind) returns null
 * and the caller falls through to the ordinary resolve-or-create.
 */
async function linkToGuest(ctx: CrazyGamesCtx, guestToken: string | undefined, userId: string): Promise<string | null> {
  if (!guestToken) return null;
  let guestId: string;
  try { guestId = verifyToken(guestToken, ctx.core.deps.jwt); } catch { return null; }
  const cols = ctx.core.deps.cols;
  if (await cols.accounts.findOne({ 'oauth.provider': CRAZYGAMES_PROVIDER, 'oauth.sub': userId }, { projection: { _id: 1 } })) {
    return null;
  }
  const guest = await cols.accounts.findOne({ _id: guestId });
  if (!guest || guest.deletedAt || !isAnonymousAccount(guest)) return null;
  const bound = await bindOAuth(cols, guestId, CRAZYGAMES_PROVIDER, userId);
  return bound.kind === 'ok' ? guestId : null;
}

/**
 * The portal owns this player's name and picture (account-integration rule: "display username and
 * profile picture"; no standalone in-game name). Re-synced on every login so a change on the portal
 * shows up next launch. A token without a usable username keeps whatever name the account had.
 * Returns the display name to report back.
 */
async function syncPortalProfile(
  cols: Collections,
  accountId: string,
  payload: CrazyGamesTokenPayload,
): Promise<string | undefined> {
  const name = typeof payload.username === 'string' ? payload.username.trim().slice(0, MAX_DISPLAY_NAME_LEN) : '';
  const nameOk = validateDisplayName(name) === null;
  const avatar = isAllowedPlatformAvatarUrl(payload.profilePictureUrl) ? payload.profilePictureUrl : undefined;
  await cols.accounts.updateOne(
    { _id: accountId },
    {
      $set: {
        nameLockedBy: CRAZYGAMES_PROVIDER,
        ...(nameOk ? { displayName: name, nameChosen: true } : {}),
        ...(avatar ? { platformAvatarUrl: avatar } : {}),
      },
      ...(avatar ? {} : { $unset: { platformAvatarUrl: '' } }),
    },
  );
  if (nameOk) return name;
  const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { displayName: 1 } });
  return doc?.displayName;
}
