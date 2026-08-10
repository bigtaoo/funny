// Split from accounts.ts (2026-08-10, independent function module range 6, part 2/6).
// Password registration / login / change (SA-1).
import { randomUUID } from 'node:crypto';
import type { Collections, ChatRegion } from '@nw/shared';
import { DUMMY_PASSWORD_HASH, hashPassword, isAnonymousAccount, normalizeLoginId, verifyPassword } from '@nw/shared';
import { touchRegion, type ResolvedAccount } from './resolve.js';

export type RegisterResult =
  | { kind: 'ok'; account: ResolvedAccount }
  | { kind: 'taken' };

/**
 * Password registration (SA-1). Creates a **new** account (does not bind to the current anonymous
 * account — promotion/merge is done by the client after login via SaveManager.reconcile,
 * ACCOUNT_DESIGN §4.4). loginId is unique after normalization.
 */
export async function registerWithPassword(
  cols: Collections,
  loginId: string,
  password: string,
  displayName: string | undefined,
  now: number,
  region: ChatRegion = 'global',
): Promise<RegisterResult> {
  const norm = normalizeLoginId(loginId);
  const hash = await hashPassword(password);
  const accountId = randomUUID();
  // Unique index 'password.loginId' guard: if the upsert hits an existing doc, nothing is inserted → taken.
  // 2026-08-03 fix: a racing upsert can also throw E11000 outright (see resolveByDevice's comment) rather
  // than cleanly no-op via $setOnInsert — that outcome means someone else's registration for this loginId
  // won the race, which is exactly what "taken" already means here.
  let res;
  try {
    res = await cols.accounts.updateOne(
      { 'password.loginId': norm },
      {
        $setOnInsert: {
          _id: accountId,
          createdAt: now,
          password: { loginId: norm, hash },
          // Explicit name at registration counts as a deliberate choice → no free rename later.
          ...(displayName ? { displayName, nameChosen: true } : {}),
          ...(region !== 'global' ? { region } : {}),
        },
      },
      { upsert: true },
    );
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
    return { kind: 'taken' };
  }
  if (!res.upsertedId) return { kind: 'taken' };
  return { kind: 'ok', account: { accountId, isNew: true, isAnonymous: false, displayName } };
}

/** Password login (SA-1). Matches loginId after normalization + compares hashes. */
export async function loginWithPassword(
  cols: Collections,
  loginId: string,
  password: string,
  region: ChatRegion = 'global',
): Promise<ResolvedAccount | null> {
  const norm = normalizeLoginId(loginId);
  const doc = await cols.accounts.findOne({ 'password.loginId': norm });
  if (!doc?.password) {
    // 2026-08-03 fix: pay the same scrypt cost as a real verify even though there's nothing to check
    // against, so a not-found loginId can't be distinguished from a found-but-wrong-password one by
    // response time (both return the same INVALID_CREDENTIALS error either way — see DUMMY_PASSWORD_HASH).
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return null;
  }
  const ok = await verifyPassword(password, doc.password.hash);
  if (!ok) return null;
  await touchRegion(cols, doc._id, region);
  return { accountId: doc._id, isNew: false, isAnonymous: isAnonymousAccount(doc), displayName: doc.displayName };
}

export type ChangePasswordResult = 'ok' | 'no-password' | 'invalid';

/** Change password (SA-1, requires JWT). Verifies the old password then replaces the hash. */
export async function changePassword(
  cols: Collections,
  accountId: string,
  oldPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const doc = await cols.accounts.findOne({ _id: accountId });
  if (!doc?.password) return 'no-password';
  const ok = await verifyPassword(oldPassword, doc.password.hash);
  if (!ok) return 'invalid';
  const hash = await hashPassword(newPassword);
  await cols.accounts.updateOne(
    { _id: accountId },
    { $set: { 'password.hash': hash } },
  );
  return 'ok';
}
