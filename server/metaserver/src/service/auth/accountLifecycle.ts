// deleteAccount/cancelAccountDeletion/recordGdprConsent (2026-08-11 split of service/auth.ts — see
// auth.ts's shell comment for the overall split rationale/module map). Deps-only — no protected
// MetaServiceBase method needed, so these take `deps` directly rather than a bound ctx.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok } from '@nw/shared';
import { accountIdOf, type ServiceDeps } from '../base.js';
import { ACCOUNT_DELETE_GRACE_MS } from './helpers.js';

/**
 * C5-b Account soft-delete (required by Apple 5.1.1(v)).
 * Writes accounts.deletedAt; subsequent auth calls return ACCOUNT_DELETED (410) unless the account
 * logs back in within the 7-day grace period, which restores it (see restoreIfWithinGrace — fixed
 * 2026-08-10, previously logging back in did NOT restore despite the confirmation copy promising it).
 * confirmToken is persisted alongside deletedAt (not just minted and discarded) so
 * POST /account/cancel-deletion can verify it and undo the soft-delete immediately within the same
 * session, without needing to log out and back in (comm-audit-2026-07-27 finding B14 — previously
 * the token was generated, returned, and never stored anywhere, and no cancellation endpoint existed
 * at all).
 */
export async function deleteAccountHandler(deps: ServiceDeps, req: FastifyRequest) {
  const accountId = accountIdOf(req);
  const { cols, now, accountCache } = deps;
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
export async function cancelAccountDeletionHandler(deps: ServiceDeps, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { confirmToken } = req.body as { confirmToken?: string };
  const { cols, now, accountCache } = deps;
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
export async function recordGdprConsentHandler(deps: ServiceDeps, req: FastifyRequest) {
  const accountId = accountIdOf(req);
  const { consent } = req.body as { consent: boolean };
  const { cols } = deps;
  await cols.accounts.updateOne(
    { _id: accountId },
    { $set: { 'flags.gdprConsent': consent } },
  );
  return ok({ ok: true });
}
