// After P2, only profileOf is retained for metaserver internal use. Full social logic has been migrated to socialsvc.
import type { Collections, ProfileView } from '@nw/shared';
import { eloToRank, INITIAL_ELO } from '@nw/shared';

/** accountId → public profile (publicId / displayName). No publicId (not yet generated) → treated as invisible. */
export async function profileOf(cols: Collections, accountId: string): Promise<ProfileView | null> {
  const doc = await cols.accounts.findOne({ _id: accountId });
  if (!doc?.publicId) return null;
  const save = await cols.saves.findOne({ _id: accountId }, { projection: { 'save.pvp.elo': 1 } });
  const elo = save?.save.pvp.elo ?? INITIAL_ELO;
  return {
    publicId: doc.publicId,
    displayName: doc.displayName ?? `Player${doc.publicId.slice(-4)}`,
    rank: eloToRank(elo),
  };
}
