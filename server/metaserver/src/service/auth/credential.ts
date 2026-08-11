// authWx/authDevice/authRegister/authLogin/authPasswordChange (2026-08-11 split of service/auth.ts —
// see auth.ts's shell comment for the overall split rationale/module map).
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
import { accountIdOf, type ServiceDeps } from '../base.js';
import { restoreIfWithinGrace, maybeGrantStarterCards } from './helpers.js';

export interface CredentialCtx {
  deps: ServiceDeps;
  rejectIfBanned: (cols: ServiceDeps['cols'], accountId: string, reply: FastifyReply) => Promise<boolean>;
  allowAuthAttempt: (req: FastifyRequest, now: number) => Promise<boolean>;
  gatewayField: { gatewayUrl?: string };
}

export async function authWxHandler(ctx: CredentialCtx, req: FastifyRequest, reply: FastifyReply) {
  const { code } = req.body as { code: string };
  const openid = await exchangeWxCode(code);
  const region = regionFromAcceptLanguage(req.headers['accept-language']);
  const { accountId, isNew, isAnonymous, displayName } = await resolveByOpenid(
    ctx.deps.cols,
    openid,
    ctx.deps.now(),
    region,
  );
  await restoreIfWithinGrace(ctx.deps, accountId);
  if (await ctx.rejectIfBanned(ctx.deps.cols, accountId, reply)) return;
  const token = signToken(accountId, ctx.deps.jwt);
  const publicId = await ensurePublicId(ctx.deps.cols, accountId);
  await maybeGrantStarterCards(ctx.deps, accountId, isNew);
  return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...ctx.gatewayField });
}

export async function authDeviceHandler(ctx: CredentialCtx, req: FastifyRequest, reply: FastifyReply) {
  const { deviceId } = req.body as { deviceId: string };
  const region = regionFromAcceptLanguage(req.headers['accept-language']);
  const { accountId, isNew, isAnonymous, displayName } = await resolveByDevice(
    ctx.deps.cols,
    deviceId,
    ctx.deps.now(),
    region,
  );
  await restoreIfWithinGrace(ctx.deps, accountId);
  if (await ctx.rejectIfBanned(ctx.deps.cols, accountId, reply)) return;
  const token = signToken(accountId, ctx.deps.jwt);
  const publicId = await ensurePublicId(ctx.deps.cols, accountId);
  await maybeGrantStarterCards(ctx.deps, accountId, isNew);
  return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...ctx.gatewayField });
}

export async function authRegisterHandler(ctx: CredentialCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!(await ctx.allowAuthAttempt(req, ctx.deps.now()))) {
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
    if (censorChat(displayName.trim(), region, ctx.deps.wordlists ?? undefined).hit) {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'display name contains disallowed words'));
    }
  }

  const result = await registerWithPassword(
    ctx.deps.cols,
    loginId,
    password,
    displayName,
    ctx.deps.now(),
    region,
  );
  if (result.kind === 'taken') {
    return reply.code(409).send(err(ErrorCode.LOGIN_ID_TAKEN, 'loginId already registered'));
  }
  const { accountId, isNew, isAnonymous } = result.account;
  const token = signToken(accountId, ctx.deps.jwt);
  const publicId = await ensurePublicId(ctx.deps.cols, accountId);
  await maybeGrantStarterCards(ctx.deps, accountId, isNew);
  return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...ctx.gatewayField });
}

export async function authLoginHandler(ctx: CredentialCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!(await ctx.allowAuthAttempt(req, ctx.deps.now()))) {
    return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many auth attempts, try later'));
  }
  const { loginId, password } = req.body as { loginId: string; password: string };
  const region = regionFromAcceptLanguage(req.headers['accept-language']);
  const account = await loginWithPassword(ctx.deps.cols, loginId, password, region);
  if (!account) {
    return reply.code(401).send(err(ErrorCode.INVALID_CREDENTIALS, 'invalid loginId or password'));
  }
  const { accountId, isNew, isAnonymous, displayName } = account;
  await restoreIfWithinGrace(ctx.deps, accountId);
  if (await ctx.rejectIfBanned(ctx.deps.cols, accountId, reply)) return;
  const token = signToken(accountId, ctx.deps.jwt);
  const publicId = await ensurePublicId(ctx.deps.cols, accountId);
  await maybeGrantStarterCards(ctx.deps, accountId, isNew);
  return ok({ token, accountId, isNew, isAnonymous, publicId, ...(displayName ? { displayName } : {}), ...ctx.gatewayField });
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
