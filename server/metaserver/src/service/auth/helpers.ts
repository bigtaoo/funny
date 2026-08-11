// Deps-only helpers shared by every auth/*.ts handler module (2026-08-11 split of service/auth.ts,
// same "独立函数模块" form as pve/helpers.ts — these two never touch a protected MetaServiceBase
// method, only `deps`, so no ctx-binding is needed at all.
import { CARD_DEFS } from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import { grantCards } from '../../cards.js';
import type { ServiceDeps } from '../base.js';

/** C5-b account soft-delete grace period: POST /account/cancel-deletion is only honored within this window. */
export const ACCOUNT_DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * C5-b grace-period restore (fix for the 2026-08-10 lockout report: a soft-deleted account could
 * never actually be restored by "logging back in" despite that being exactly what the deletion
 * confirmation copy (settings.deleteAccount.confirmBody), the privacy policy §7, and this account's
 * own DELETE /account doc comment promise). Root cause was ordering: every auth entrypoint called
 * rejectIfBanned — which unconditionally 410s a deletedAt account — *before* signing a token, so
 * POST /account/cancel-deletion (the only working undo, added by P0-13/B14) was unreachable once
 * deletedAt was set: it requires a bearer token, and no token could ever be issued again.
 * Called right before rejectIfBanned in every credential-resolution auth handler (authWx/authDevice/
 * authLogin/authOAuth): if this account is soft-deleted but still within the 7-day grace window, a
 * successful login *is* the restore action — clear deletedAt/deletionConfirmToken so rejectIfBanned
 * sees a live account and the rest of the handler proceeds normally (ban checks still apply as usual).
 * Past the grace window this is a no-op — rejectIfBanned still 410s, matching "超过 7 天数据将被永久清除".
 */
export async function restoreIfWithinGrace(deps: ServiceDeps, accountId: string): Promise<void> {
  const { cols, now, accountCache } = deps;
  const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { deletedAt: 1 } });
  if (!doc?.deletedAt || now() - doc.deletedAt >= ACCOUNT_DELETE_GRACE_MS) return;
  await cols.accounts.updateOne(
    { _id: accountId },
    { $unset: { deletedAt: '', deletionConfirmToken: '' } },
  );
  accountCache.invalidateBanStatus(accountId);
}

/** Grant lichuang/chenshou/suyuan to a brand-new account (CHARACTER_CARDS_DESIGN §4). No-op if account already has cards. */
export async function maybeGrantStarterCards(deps: ServiceDeps, accountId: string, isNew: boolean): Promise<void> {
  if (!isNew) return;
  const { cols, now } = deps;
  const save = await getOrCreateSave(cols, accountId, now());
  if (save.cardInvCount > 0) return;
  await grantCards(cols, now, accountId, [
    CARD_DEFS['lichuang']!,
    CARD_DEFS['chenshou']!,
    CARD_DEFS['suyuan']!,
  ], 'starter');
}
