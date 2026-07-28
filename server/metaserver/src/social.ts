// After P2, only profileOf is retained for metaserver internal use. Full social logic has been migrated to socialsvc.
import type { Collections, ProfileView } from '@nw/shared';
import { eloToRank, INITIAL_ELO } from '@nw/shared';

/** Fields actually needed to build a ProfileView — used as the projection on both the single and batch paths. */
const ACCOUNT_PROFILE_PROJECTION = { publicId: 1, displayName: 1 } as const;
const SAVE_PROFILE_PROJECTION = { 'save.pvp.elo': 1, 'save.equipped': 1 } as const;

/** Shared transform for both profileOf and batch-profiles — single source of truth for the business rules
 * (rank derivation, displayName fallback, equipped title/avatar extraction). No publicId → invisible (null). */
function toProfileView(
  account: { publicId?: string; displayName?: string } | null | undefined,
  save: { save: { pvp: { elo: number }; equipped?: Record<string, unknown> } } | null | undefined,
): ProfileView | null {
  if (!account?.publicId) return null;
  const elo = save?.save.pvp.elo ?? INITIAL_ELO;
  const equipped = save?.save.equipped as Record<string, string> | undefined;
  const equippedTitle = equipped?.['title'];
  const avatarId = equipped?.['avatar'];
  return {
    publicId: account.publicId,
    displayName: account.displayName ?? `Player${account.publicId.slice(-4)}`,
    rank: eloToRank(elo),
    ...(equippedTitle ? { equippedTitle } : {}),
    ...(avatarId ? { avatarId } : {}),
  };
}

/** accountId → public profile (publicId / displayName). No publicId (not yet generated) → treated as invisible. */
export async function profileOf(cols: Collections, accountId: string): Promise<ProfileView | null> {
  const doc = await cols.accounts.findOne({ _id: accountId }, { projection: ACCOUNT_PROFILE_PROJECTION });
  if (!doc?.publicId) return null;
  const save = await cols.saves.findOne({ _id: accountId }, { projection: SAVE_PROFILE_PROJECTION });
  return toProfileView(doc, save);
}

/**
 * Batch variant of profileOf — was `Promise.all(ids.map(profileOf))`, i.e. 2 unprojected/projected findOnes
 * per id (2N queries for N ids, plus the accounts side pulled the entire document including password hashes
 * and oauth arrays). Two `$in` queries + an in-memory join instead (2026-07-27 audit finding). Missing ids are
 * simply absent from both maps, which `toProfileView` already treats as "no publicId" → null → filtered out.
 */
export async function profilesOf(cols: Collections, accountIds: string[]): Promise<Map<string, ProfileView>> {
  const result = new Map<string, ProfileView>();
  if (accountIds.length === 0) return result;
  const [accounts, saves] = await Promise.all([
    cols.accounts.find({ _id: { $in: accountIds } }, { projection: ACCOUNT_PROFILE_PROJECTION }).toArray(),
    cols.saves.find({ _id: { $in: accountIds } }, { projection: SAVE_PROFILE_PROJECTION }).toArray(),
  ]);
  const saveById = new Map(saves.map((s) => [s._id, s]));
  for (const acct of accounts) {
    const view = toProfileView(acct, saveById.get(acct._id));
    if (view) result.set(acct._id, view);
  }
  return result;
}
