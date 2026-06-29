// P2 后仅保留 profileOf 供 metaserver 内部使用。完整社交逻辑已迁至 socialsvc。
import type { Collections, ProfileView } from '@nw/shared';
import { eloToRank, INITIAL_ELO } from '@nw/shared';

/** accountId → 公开资料（publicId / displayName）。无 publicId（未生成）视为不可见。 */
export async function profileOf(cols: Collections, accountId: string): Promise<ProfileView | null> {
  const doc = await cols.accounts.findOne({ _id: accountId });
  if (!doc?.publicId) return null;
  const save = await cols.saves.findOne({ _id: accountId }, { projection: { 'save.pvp.elo': 1 } });
  const elo = save?.save.pvp.elo ?? INITIAL_ELO;
  return {
    publicId: doc.publicId,
    displayName: doc.displayName ?? `玩家${doc.publicId.slice(-4)}`,
    rank: eloToRank(elo),
  };
}
