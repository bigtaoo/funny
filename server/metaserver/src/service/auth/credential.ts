// authWx/authDevice/authRegister/authLogin/authPasswordChange (2026-08-11 split of service/auth.ts —
// see auth.ts's shell comment for the overall split rationale/module map).
//
// 2026-08-11 ctx-bind cleanup (see base.ts's header): `CredentialCtx` used to flatten `deps`/
// `rejectIfBanned`/`gatewayField` (all MetaCore members, each individually `.bind(this.core)`-ed) plus
// `allowAuthAttempt` (AuthService's own private method) into one object. Now that MetaCore's members
// are plain public methods, the MetaCore-derived half collapses to a single `core: MetaCore` field —
// no bind needed, `ctx.core.rejectIfBanned(...)` is an ordinary method call — while `allowAuthAttempt`
// (genuinely AuthService-only, not a MetaCore member) stays a separate ctx field.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok, signToken } from '@nw/shared';
import { regionFromAcceptLanguage, censorChat } from '@nw/shared';
import { validateLoginId, validatePassword, validateDisplayName } from '@nw/shared';
import {
  changePassword,
  ensurePublicId,
  exchangeWxCode,
  loginWithPassword,
  registerWithPassword,
  resolveByDevice,
  resolveByOpenid,
} from '../../accounts.js';
import { accountIdOf, type ServiceDeps, type MetaCore } from '../base.js';
import { restoreIfWithinGrace, maybeGrantStarterCards } from './helpers.js';

export interface CredentialCtx {
  core: MetaCore;
  allowAuthAttempt: (req: FastifyRequest, now: number) => Promise<boolean>;
}

export async function authWxHandler(ctx: CredentialCtx, req: FastifyRequest, reply: FastifyReply) {
  const { code } = req.body as { code: string };
  const openid = await exchangeWxCode(code);
  const region = regionFromAcceptLanguage(req.headers['accept-language']);
  const { accountId, isNew, isAnonymous, displayName } = await resolveByOpenid(
    ctx.core.deps.cols,
    openid,
    ctx.core.deps.now(),
    region,
  );
  await restoreIfWithinGrace(ctx.core.deps, accountId);
  if (await ctx.core.rejectIfBanned(ctx.core.deps.cols, accountId, reply)) return;
  const token = signToken(accountId, ctx.core.deps.jwt);
  const publicId = await ensurePublicId(ctx.core.deps.cols, accountId);
  await maybeGrantStarterCards(ctx.core.deps, accountId, isNew);
  return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...ctx.core.gatewayField });
}

export async function authDeviceHandler(ctx: CredentialCtx, req: FastifyRequest, reply: FastifyReply) {
  const { deviceId } = req.body as { deviceId: string };
  const region = regionFromAcceptLanguage(req.headers['accept-language']);
  const { accountId, isNew, isAnonymous, displayName } = await resolveByDevice(
    ctx.core.deps.cols,
    deviceId,
    ctx.core.deps.now(),
    region,
  );
  await restoreIfWithinGrace(ctx.core.deps, accountId);
  if (await ctx.core.rejectIfBanned(ctx.core.deps.cols, accountId, reply)) return;
  const token = signToken(accountId, ctx.core.deps.jwt);
  const publicId = await ensurePublicId(ctx.core.deps.cols, accountId);
  await maybeGrantStarterCards(ctx.core.deps, accountId, isNew);
  return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...ctx.core.gatewayField });
}

export async function authRegisterHandler(ctx: CredentialCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!(await ctx.allowAuthAttempt(req, ctx.core.deps.now()))) {
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
    if (censorChat(displayName.trim(), region, ctx.core.deps.wordlists ?? undefined).hit) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'display name contains disallowed words'));
    }
  }

  const result = await registerWithPassword(
    ctx.core.deps.cols,
    loginId,
    password,
    displayName,
    ctx.core.deps.now(),
    region,
  );
  if (result.kind === 'taken') {
    return reply.code(409).send(err(ErrorCode.LOGIN_ID_TAKEN, 'loginId already registered'));
  }
  const { accountId, isNew, isAnonymous } = result.account;
  const token = signToken(accountId, ctx.core.deps.jwt);
  const publicId = await ensurePublicId(ctx.core.deps.cols, accountId);
  await maybeGrantStarterCards(ctx.core.deps, accountId, isNew);
  return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...ctx.core.gatewayField });
}

export async function authLoginHandler(ctx: CredentialCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!(await ctx.allowAuthAttempt(req, ctx.core.deps.now()))) {
    return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many auth attempts, try later'));
  }
  const { loginId, password } = req.body as { loginId: string; password: string };
  const region = regionFromAcceptLanguage(req.headers['accept-language']);
  const account = await loginWithPassword(ctx.core.deps.cols, loginId, password, region);
  if (!account) {
    return reply.code(401).send(err(ErrorCode.INVALID_CREDENTIALS, 'invalid loginId or password'));
  }
  const { accountId, isNew, isAnonymous, displayName } = account;
  await restoreIfWithinGrace(ctx.core.deps, accountId);
  if (await ctx.core.rejectIfBanned(ctx.core.deps.cols, accountId, reply)) return;
  const token = signToken(accountId, ctx.core.deps.jwt);
  const publicId = await ensurePublicId(ctx.core.deps.cols, accountId);
  await maybeGrantStarterCards(ctx.core.deps, accountId, isNew);
  return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...ctx.core.gatewayField });
}

export async function authPasswordChangeHandler(deps: ServiceDeps, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { oldPassword, newPassword } = req.body as {
    oldPassword: string;
    newPassword: string;
  };
  const pwErr = validatePassword(newPassword);
  if (pwErr) return reply.code(400).send(err(ErrorCode.WEAK_PASSWORD, pwErr));
  const result = await changePassword(deps.cols, accountId, oldPassword, newPassword);
  if (result === 'no-password') {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'account has no password credential'));
  }
  if (result === 'invalid') {
    return reply.code(401).send(err(ErrorCode.INVALID_CREDENTIALS, 'old password mismatch'));
  }
  return ok({ ok: true });
}
