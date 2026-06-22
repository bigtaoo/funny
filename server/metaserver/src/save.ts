// save-service 逻辑（S0-7）。乐观锁走单文档原子更新（META_DESIGN.md §6.3）：
// findOneAndUpdate 用 {_id, rev} 做守卫，并发 PUT 只有一个赢，另一个收 409。
import type { Collections, SaveData, SyncPatch } from '@nw/shared';
import { makeNewSave, createLogger } from '@nw/shared';

const log = createLogger('meta:save');

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
 * 信任边界硬墙：只读 patch 的 2 个白名单字段（equipped/flags），任何额外字段
 * （wallet/inventory/gacha/pvp 权威段，以及 PVE_INTEGRITY_PLAN §8 起转为服务器权威的
 * progress/materials/pveUpgrades）结构性丢弃——HTTP body 无类型，客户端塞了也不落库。
 * 后三段只由 /pve/* + ranked 结算写。
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

/**
 * 把迁移后存档（含 rev+1）原子写库，最多 3 次重试。
 * 用于「读到存档 → migrateIfStale 得到新 save → 写回」场景。
 * 并发冲突时重读当前存档再次迁移后写（幂等：重入迁移不重复结算/重置）。
 * 返回最终落库的存档。
 */
export async function writeMigratedSave(
  cols: Collections,
  migratedSave: SaveData,
  now: number,
  migrate: (save: SaveData) => Promise<{ migrated: boolean; save: SaveData }>,
): Promise<SaveData> {
  let save = migratedSave;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next: SaveData = { ...save, rev: save.rev + 1, updatedAt: now };
    const res = await cols.saves.findOneAndUpdate(
      { _id: save.accountId, rev: save.rev },
      { $set: { save: next, rev: next.rev } },
      { returnDocument: 'after' },
    );
    if (res) return res.save;
    // 并发冲突：重读 + 再次迁移后重试
    const cur = await cols.saves.findOne({ _id: save.accountId });
    if (!cur) return save;
    const r = await migrate(cur.save);
    if (!r.migrated) return cur.save; // 已被并发迁移
    save = r.save;
    log.info('writeMigratedSave: retrying after conflict', { accountId: save.accountId, attempt });
  }
  return save;
}
