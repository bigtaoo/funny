// 家族繁荣度（G2 / SLG_DESIGN §17.4）：评分 = familyProsperity(territory, member, activity)，
// 读时惰性衰减（类比资源 yield，不每日 tick）。territory = 家族成员当前占领的格子数（与 getMe
// 的 per-player countDocuments 同源，按成员展开聚合）。显式刷新点（占领/围攻/建门/settle）回写
// prosperity + prosperityUpdatedAt 锚点。
import { familyProsperity, decayProsperity } from '@nw/shared';
import type { WorldCollections, FamilyDoc } from './db';

/** 读时惰性衰减后的有效繁荣度（不回写）。base 缺省视 0，锚点缺省视 now（无衰减）。 */
export function effectiveProsperity(fam: Pick<FamilyDoc, 'prosperity' | 'prosperityUpdatedAt'>, now: number): number {
  const base = fam.prosperity ?? 0;
  const anchor = fam.prosperityUpdatedAt ?? now;
  const dtDays = Math.max(0, (now - anchor) / 86_400_000);
  return decayProsperity(base, dtDays);
}

/**
 * 重算并回写家族繁荣度（§17.4 显式刷新点）。territory = 家族成员占领的格子数，
 * member = FamilyDoc.memberCount，activity = FamilyDoc.activity（赛季累计活跃）。
 * 回写 prosperity + prosperityUpdatedAt=now。返回新值（已是「刚刷新」故无需再衰减）。
 * best-effort 语义由调用方决定；家族不存在 → 返回 0 不写。
 */
export async function refreshFamilyProsperity(
  cols: WorldCollections,
  worldId: string,
  familyId: string,
  now: number,
): Promise<number> {
  const fam = await cols.families.findOne({ _id: familyId });
  if (!fam) return 0;
  const members = await cols.familyMembers.find({ familyId }).project({ accountId: 1 }).toArray();
  const ids = members.map((m) => (m as unknown as { accountId: string }).accountId);
  const territoryCount = ids.length > 0
    ? await cols.tiles.countDocuments({ worldId, ownerId: { $in: ids } })
    : 0;
  const prosperity = familyProsperity(territoryCount, fam.memberCount, fam.activity ?? 0);
  await cols.families.updateOne(
    { _id: familyId },
    { $set: { prosperity, prosperityUpdatedAt: now } },
  );
  return prosperity;
}

/** 宗门繁荣度聚合 = ∑ 成员家族的有效繁荣度（§17.4，settle/建门/G6 采集时刷新）。 */
export async function aggregateSectProsperity(cols: WorldCollections, sectId: string, now: number): Promise<number> {
  const fams = await cols.families.find({ sectId }).toArray();
  return fams.reduce((sum, f) => sum + effectiveProsperity(f, now), 0);
}
