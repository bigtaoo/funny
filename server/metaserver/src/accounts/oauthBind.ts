// Split from accounts.ts (2026-08-10, independent function module range 6, part 5/6).
// Binding a second credential (OAuth or password) onto an already-existing account (SA-2).
import type { Collections } from '@nw/shared';
import { hashPassword, normalizeLoginId } from '@nw/shared';

export type BindResult =
  | { kind: 'ok' }
  | { kind: 'already_bound' }
  | { kind: 'login_id_taken' };

/**
 * Bind an OAuth credential to an existing account (SA-2).
 * - provider+sub not taken by another account → append to the current account's oauth[]; `isAnonymous=false`.
 * - Already taken by another account → `already_bound` (frontend should prompt the user to log in with that account instead).
 */
export async function bindOAuth(
  cols: Collections,
  accountId: string,
  provider: string,
  sub: string,
): Promise<BindResult> {
  const existing = await cols.accounts.findOne({ 'oauth.provider': provider, 'oauth.sub': sub });
  if (existing && existing._id !== accountId) return { kind: 'already_bound' };
  if (existing) return { kind: 'ok' }; // already on this account; idempotent
  try {
    await cols.accounts.updateOne(
      { _id: accountId },
      { $addToSet: { oauth: { provider, sub } } },
    );
  } catch (e) {
    // 2026-08-03 fix: the compound (provider,sub) unique index means a concurrent bind of this same
    // credential to a *different* account (racing this check-then-write) surfaces as E11000 here rather
    // than being caught by the `existing` check above, which ran before either write landed.
    if ((e as { code?: number }).code === 11000) return { kind: 'already_bound' };
    throw e;
  }
  return { kind: 'ok' };
}

/**
 * Bind a password credential to an existing account (SA-2).
 * - loginId not yet taken → set the password field; `isAnonymous=false`.
 * - Already taken → `login_id_taken`.
 * - Account already has a password → idempotently return ok (do not overwrite; use /auth/password/change to change it).
 */
export async function bindPassword(
  cols: Collections,
  accountId: string,
  loginId: string,
  password: string,
): Promise<BindResult> {
  const norm = normalizeLoginId(loginId);
  const selfDoc = await cols.accounts.findOne({ _id: accountId });
  if (selfDoc?.password) return { kind: 'ok' }; // already has a password; idempotent
  const taken = await cols.accounts.findOne({ 'password.loginId': norm });
  if (taken && taken._id !== accountId) return { kind: 'login_id_taken' };
  const hash = await hashPassword(password);
  try {
    await cols.accounts.updateOne(
      { _id: accountId, password: { $exists: false } },
      { $set: { 'password.loginId': norm, 'password.hash': hash } },
    );
  } catch (e) {
    // 2026-08-03 fix: the loginId unique index means a concurrent bind of this same loginId to a
    // *different* account (racing this check-then-write) surfaces as E11000 here rather than being
    // caught by the `taken` check above, which ran before either write landed.
    if ((e as { code?: number }).code === 11000) return { kind: 'login_id_taken' };
    throw e;
  }
  return { kind: 'ok' };
}
