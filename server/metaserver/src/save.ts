// save-service 逻辑（S0-7）。乐观锁走单文档原子更新（META_DESIGN.md §6.3）：
// findOneAndUpdate 用 {_id, rev} 做守卫，并发 PUT 只有一个赢，另一个收 409。
import type { Collections, SaveData, SyncPatch } from '@nw/shared';
import { makeNewSave } from '@nw/shared';

export type PutResult =
  | { kind: 'ok'; save: SaveData }
  | { kind: 'conflict'; save: SaveData };

/** 拉取存档；不存在则创建新档落库。 */
export async function getOrCreateSave(
  cols: Collections,
  accountId: string,
  now: number,
): Promise<SaveData> {
  const doc = await cols.saves.findOne({ _id: accountId });
  if (doc) return doc.save;

  const save = makeNewSave(accountId, now);
  // upsert 防并发首建竞态：已存在则读回已有的。
  await cols.saves.updateOne(
    { _id: accountId },
    { $setOnInsert: { _id: accountId, save, rev: save.rev } },
    { upsert: true },
  );
  const fresh = await cols.saves.findOne({ _id: accountId });
  return fresh ? fresh.save : save;
}

/**
 * 仅把客户端同步段覆盖进存档；服务器权威段保持不变（SERVER_API.md §2.2）。
 * 信任边界硬墙：只读 patch 的 5 个白名单字段，任何额外字段（wallet/inventory/
 * gacha/pvp 等权威段）结构性丢弃——HTTP body 是无类型 JSON，客户端塞了也不落库。
 * 导出供 always-run 单测（e2e 仅 Mongo 在跑时验，本函数纯逻辑应无条件覆盖）。
 */
export function applySyncPatch(
  prev: SaveData,
  patch: SyncPatch,
  now: number,
  nextRev: number,
): SaveData {
  return {
    ...prev,
    rev: nextRev,
    updatedAt: now,
    ...(patch.progress ? { progress: patch.progress } : {}),
    ...(patch.materials ? { materials: patch.materials } : {}),
    ...(patch.pveUpgrades ? { pveUpgrades: patch.pveUpgrades } : {}),
    ...(patch.equipped ? { equipped: patch.equipped } : {}),
    ...(patch.flags ? { flags: patch.flags } : {}),
  };
}

/**
 * 乐观锁推送同步段。clientRev 必须等于云端 rev，否则返回 conflict + 当前云端值。
 * 成功回推规范化后的存档（rev+1）。
 */
export async function putSave(
  cols: Collections,
  accountId: string,
  clientRev: number,
  patch: SyncPatch,
  now: number,
): Promise<PutResult> {
  const cur = await getOrCreateSave(cols, accountId, now);

  if (cur.rev !== clientRev) {
    return { kind: 'conflict', save: cur };
  }

  const next = applySyncPatch(cur, patch, now, cur.rev + 1);
  // rev 守卫保证原子性：并发同 rev 只有一个匹配成功。
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId, rev: clientRev },
    { $set: { save: next, rev: next.rev } },
    { returnDocument: 'after' },
  );

  if (!res) {
    // 被并发写抢先，rev 已变 → 冲突，回读当前值。
    const fresh = await getOrCreateSave(cols, accountId, now);
    return { kind: 'conflict', save: fresh };
  }
  return { kind: 'ok', save: res.save };
}
