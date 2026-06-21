// 装备库存后端（E2 合成 + worldsvc 拍卖托管/转移）。EQUIPMENT_DESIGN §3 / §6 / §18。
//
// 全部服务器权威（L2）：装备实例库存 SaveData.equipmentInv 仅由本模块写，PUT /save 不可写
// （SyncPatch 已收窄）。写入走乐观锁 rev 守卫 + 重试（同 internal.ts 材料扣发范式）。
//
// 本切片职责：
//   · craftEquipment   玩家合成：扣文具材料 → roll 一件 +0 基础装备 → 入库（300 上限）。idemKey 幂等。
//   · escrowEquipment  worldsvc 挂拍托管：校验未穿戴/未锁 → 移出卖方库存 → 回快照给 worldsvc 存挂单。
//   · grantEquipment   worldsvc 成交转移 / 撤单过期退回：把实例快照写入目标账号库存（按 id 覆盖即幂等）。
//
// 强化/分解/穿戴（E3/E4）、关卡掉落 faucet 不在本切片。
import {
  EQUIPMENT_DEFS,
  EQUIPMENT_INV_CAP,
  EQUIPMENT_IDEM_TTL_SEC,
  equipmentInvCount,
  rollCraftedAffixes,
  type Collections,
  type SaveData,
  type EquipmentInstance,
} from '@nw/shared';
import { getOrCreateSave } from './save.js';

/** 业务错误码（HTTP 映射在路由层）。 */
export type EquipErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'EQUIP_NOT_FOUND'
  | 'INSUFFICIENT_MATERIALS'
  | 'INVENTORY_FULL'
  | 'EQUIP_LOCKED'
  | 'EQUIP_IN_USE'
  | 'REV_CONFLICT';

export interface EquipError {
  error: string;
  code: EquipErrorCode;
}

const REV_RETRIES = 3;

function idemExpireAt(now: number): Date {
  return new Date(now + EQUIPMENT_IDEM_TTL_SEC * 1000);
}

/** 某实例是否正被穿戴（gear.global / gear.byUnit 任一槽引用）。穿戴中不可挂拍/不可被移出。 */
function isEquipped(save: SaveData, instanceId: string): boolean {
  const gear = save.gear ?? {};
  const maps = [gear.global, ...Object.values(gear.byUnit ?? {})];
  for (const m of maps) {
    if (!m) continue;
    for (const slot of Object.keys(m)) {
      if ((m as Record<string, string | undefined>)[slot] === instanceId) return true;
    }
  }
  return false;
}

/**
 * 合成一件 +0 基础装备（E2，EQUIPMENT_DESIGN §4/§7）。
 * 扣 EQUIPMENT_DEFS[defId].craftCost 材料 → roll 主+副词条 → 入库（< 300 上限）。
 * idempotencyKey 幂等：重放返回首次结果（不二次扣料、不二次 roll；roll 本身由 key 派生确定性）。
 */
export async function craftEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  defId: string,
  idempotencyKey: string,
): Promise<{ instance: EquipmentInstance; save: SaveData } | EquipError> {
  const def = EQUIPMENT_DEFS[defId];
  if (!def) return { error: 'unknown defId', code: 'BAD_REQUEST' };
  if (!def.craftCost) return { error: 'defId not craftable', code: 'BAD_REQUEST' };
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };

  // 确定性产出（id + 词条均由 idempotencyKey 派生 → 重放/重试一致，杜绝"重试改命"）。
  const instance: EquipmentInstance = {
    id: `eq_${idempotencyKey}`,
    defId,
    rarity: def.rarity,
    level: 0,
    affixes: rollCraftedAffixes(defId, idempotencyKey),
  };
  const craftCost = def.craftCost;

  // 预校验当前存档（友好报错；正式守卫在 rev 循环内复查）。
  const cur = await getOrCreateSave(cols, accountId, now());
  for (const [mat, qty] of Object.entries(craftCost)) {
    if ((cur.materials?.[mat] ?? 0) < qty) return { error: `insufficient ${mat}`, code: 'INSUFFICIENT_MATERIALS' };
  }
  if (equipmentInvCount(cur.equipmentInv) >= EQUIPMENT_INV_CAP) {
    return { error: 'equipment inventory full', code: 'INVENTORY_FULL' };
  }

  // 幂等闸门：先抢占 idemKey（唯一 _id）。抢占失败 = 已合成 → 重放首次结果。
  try {
    await cols.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'craft',
      result: instance,
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      const save = await getOrCreateSave(cols, accountId, now());
      return { instance: (prev?.result as EquipmentInstance) ?? instance, save };
    }
    throw e;
  }

  // 抢占成功 → 扣料 + 入库（乐观锁 rev 守卫 + 重试）。
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    const save = doc.save;
    // rev 循环内复查（并发耗材/满仓）。失败则释放 idem 抢占，让客户端纠正后重试。
    for (const [mat, qty] of Object.entries(craftCost)) {
      if ((save.materials?.[mat] ?? 0) < qty) {
        await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
        return { error: `insufficient ${mat}`, code: 'INSUFFICIENT_MATERIALS' };
      }
    }
    if (equipmentInvCount(save.equipmentInv) >= EQUIPMENT_INV_CAP) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'equipment inventory full', code: 'INVENTORY_FULL' };
    }
    const nextMaterials = { ...save.materials };
    for (const [mat, qty] of Object.entries(craftCost)) nextMaterials[mat] = (nextMaterials[mat] ?? 0) - qty;
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      materials: nextMaterials,
      equipmentInv: { ...(save.equipmentInv ?? {}), [instance.id]: instance },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { instance, save: next };
    // rev 冲突（并发 PUT /save / pve 写）→ 重读重试
  }
  // 重试耗尽：保留 idem 抢占（结果实例已记账，下次重放即回；不重复扣料）。
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/**
 * worldsvc 挂拍托管：把卖方一件装备实例移出库存，返回快照（worldsvc 存进挂单 doc，成交/退回时回放）。
 * 穿戴中（gear 引用）/ locked → 拒绝。orderId 幂等：重放返回首次托管的快照。
 */
export async function escrowEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  instanceId: string,
  orderId: string,
): Promise<{ instance: EquipmentInstance } | EquipError> {
  if (!instanceId || !orderId) return { error: 'instanceId + orderId required', code: 'BAD_REQUEST' };

  // 重放
  const existing = await cols.equipmentIdem.findOne({ _id: orderId });
  if (existing?.op === 'escrow') return { instance: existing.result as EquipmentInstance };

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;
    const inst = save.equipmentInv?.[instanceId];
    if (!inst) {
      // 并发已托管（idem 已写）→ 重放；否则确实不存在。
      const replay = await cols.equipmentIdem.findOne({ _id: orderId });
      if (replay?.op === 'escrow') return { instance: replay.result as EquipmentInstance };
      return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
    }
    if (inst.locked) return { error: 'equipment locked', code: 'EQUIP_LOCKED' };
    if (isEquipped(save, instanceId)) return { error: 'equipment in use (equipped)', code: 'EQUIP_IN_USE' };

    const nextInv = { ...(save.equipmentInv ?? {}) };
    delete nextInv[instanceId];
    const next: SaveData = { ...save, rev: save.rev + 1, updatedAt: now(), equipmentInv: nextInv };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // 记账本（snapshot 用于成交转移 / 退回；$setOnInsert 防并发覆盖）。
      await cols.equipmentIdem.updateOne(
        { _id: orderId },
        { $setOnInsert: { accountId, op: 'escrow', result: inst, expireAt: idemExpireAt(now()) } },
        { upsert: true },
      );
      return { instance: inst };
    }
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/**
 * worldsvc 成交转移（给买方）/ 撤单/过期/季末退回（给卖方）：把实例快照写入目标账号库存。
 * 按 instance.id 覆盖写 → 天然幂等（重发同一实例不重复增）。
 * 转移属"有意获得"，**不卡 300 上限**（满仓溢出转邮件暂存是 §13 后续，本切片不阻断成交防资损）。
 */
export async function grantEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  instance: EquipmentInstance,
): Promise<{ ok: true } | EquipError> {
  if (!instance?.id) return { error: 'instance required', code: 'BAD_REQUEST' };
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      equipmentInv: { ...(save.equipmentInv ?? {}), [instance.id]: instance },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { ok: true };
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}
