// 装备库存后端（E2 合成 + worldsvc 拍卖托管/转移）。EQUIPMENT_DESIGN §3 / §6 / §18。
//
// 全部服务器权威（L2）：装备实例库存 SaveData.equipmentInv 仅由本模块写，PUT /save 不可写
// （SyncPatch 已收窄）。写入走乐观锁 rev 守卫 + 重试（同 internal.ts 材料扣发范式）。
//
// 职责：
//   · craftEquipment   玩家合成（E2）：扣文具材料 → roll 一件 +0 基础装备 → 入库（300 上限）。idemKey 幂等。
//   · escrowEquipment  worldsvc 挂拍托管（E2.5）：校验未穿戴/未锁 → 移出卖方库存 → 回快照给 worldsvc 存挂单。
//   · grantEquipment   worldsvc 成交转移 / 撤单过期退回（E2.5）：把实例快照写入目标账号库存（按 id 覆盖即幂等）。
//   · enhanceEquipment 玩家强化（E3）：服务器掷骰（成功率表）→ 扣材料 + 金币（commercial 权威）→ 成功 level+1。idemKey 幂等。
//   · salvageEquipment 玩家分解（E3）：+0~4 件返 70% 打造材料、移出库存（+5 拒、穿戴中/锁定拒），批量。idemKey 幂等。
//   · equipEquipment   玩家穿戴（E4）：校验槽位匹配 → 写 gear.global[slot]（或 byUnit），instanceId=null 卸下。纯状态。
//
// 关卡掉落 faucet（E2 剩余）、洗练（E6）不在本切片。
import {
  EQUIPMENT_DEFS,
  EQUIPMENT_INV_CAP,
  EQUIPMENT_IDEM_TTL_SEC,
  EQUIP_MAX_LEVEL,
  EQUIP_SLOTS,
  SALVAGE_MAX_LEVEL,
  equipmentInvCount,
  rollCraftedAffixes,
  rollEnhanceSuccess,
  enhanceCost,
  salvageRefund,
  type Collections,
  type SaveData,
  type GearLoadout,
  type EquipSlot,
  type EquipmentInstance,
} from '@nw/shared';
import { getOrCreateSave } from './save.js';
import { mirrorCoins } from './economy.js';
import type { CommercialClient } from './commercialClient.js';

/** 业务错误码（HTTP 映射在路由层）。 */
export type EquipErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'NOT_IMPLEMENTED'
  | 'EQUIP_NOT_FOUND'
  | 'INSUFFICIENT_MATERIALS'
  | 'INSUFFICIENT_FUNDS'
  | 'INVENTORY_FULL'
  | 'EQUIP_LOCKED'
  | 'EQUIP_IN_USE'
  | 'ENHANCE_MAX_LEVEL'
  | 'NOT_SALVAGEABLE'
  | 'INVALID_SLOT'
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

// ── E3 强化（EQUIPMENT_DESIGN §6 / §18.2）──────────────────────────────────────

/**
 * 强化一件装备（level → level+1）。EQUIPMENT_DESIGN §6：服务器掷骰（成功率表，每升一级 −10%），
 * 成功/失败都扣材料 + 金币（失败损耗是核心 sink，§6.2）；失败不掉级、不碎。
 *
 * 金币走 commercial 权威（`save.wallet.coins` 仅镜像，economy.ts §0），故强化依赖 commercial 在线。
 * 幂等（idempotencyKey）：掷骰结果 + 消耗均绑定 key，重放返回首次结果（不二次掷骰/扣料）。
 * commercial.spend 以 idemKey 为 orderId 天然幂等 → 重放再调一次不会二次扣币。
 *
 * 排序（玩家安全）：先原子改存档（扣材料 + 成功则 level+1，rev 守卫），**再**扣金币。
 * 改档失败（rev 耗尽/材料不足）时金币未动，可安全释放幂等抢占重来；改档成功后即使扣币环节
 * 网络抖动，重放路径会幂等补扣（spend(idemKey)）+ 镜像，杜绝漏扣。
 */
export async function enhanceEquipment(
  cols: Collections,
  commercial: CommercialClient,
  now: () => number,
  accountId: string,
  instanceId: string,
  idempotencyKey: string,
): Promise<{ success: boolean; instance: EquipmentInstance; save: SaveData } | EquipError> {
  if (!instanceId) return { error: 'instanceId required', code: 'BAD_REQUEST' };
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };

  // 重放：返回首次掷骰结果 + 幂等补扣金币（覆盖"改档成功但扣币环节中断"窗口）。
  const replay = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'enhance') {
    const r = replay.result as { success: boolean; instance: EquipmentInstance; coins: number };
    const save = await settleEnhanceCoins(cols, commercial, now, accountId, idempotencyKey, r.coins);
    return { success: r.success, instance: r.instance, save };
  }

  // 金币走 commercial 权威；未配置则强化不可用（同 shop/gacha 503）。
  if (!commercial.available) return { error: 'commercial service unavailable', code: 'NOT_IMPLEMENTED' };

  const cur = await getOrCreateSave(cols, accountId, now());
  const inst0 = cur.equipmentInv?.[instanceId];
  if (!inst0) return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
  if (inst0.level >= EQUIP_MAX_LEVEL) return { error: 'already max level', code: 'ENHANCE_MAX_LEVEL' };

  const fromLevel = inst0.level;
  const cost = enhanceCost(fromLevel);
  // 预校验材料（友好报错；rev 循环内复查）。
  for (const [mat, qty] of Object.entries(cost.materials)) {
    if ((cur.materials?.[mat] ?? 0) < qty) return { error: `insufficient ${mat}`, code: 'INSUFFICIENT_MATERIALS' };
  }
  // 预校验金币（commercial 权威；不足则不动任何状态，友好 402）。
  const wallet = await commercial.getWallet(accountId);
  if ((wallet?.coins ?? 0) < cost.coins) return { error: 'not enough coins', code: 'INSUFFICIENT_FUNDS' };

  const success = rollEnhanceSuccess(idempotencyKey, fromLevel);
  const instanceAfter: EquipmentInstance = success ? { ...inst0, level: fromLevel + 1 } : { ...inst0 };

  // 幂等抢占（结果含 coins，供重放补扣）。dup = 并发重复 → 走重放路径。
  try {
    await cols.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'enhance',
      result: { success, instance: instanceAfter, coins: cost.coins },
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      const r = prev?.result as { success: boolean; instance: EquipmentInstance; coins: number };
      const save = await settleEnhanceCoins(cols, commercial, now, accountId, idempotencyKey, r.coins);
      return { success: r.success, instance: r.instance, save };
    }
    throw e;
  }

  // 原子改档：扣材料 + 成功则 level+1（rev 守卫；instance 仍在且等级未变才生效）。
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    const save = doc.save;
    const inst = save.equipmentInv?.[instanceId];
    if (!inst) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
    }
    if (inst.level !== fromLevel) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'instance level changed, retry', code: 'REV_CONFLICT' };
    }
    for (const [mat, qty] of Object.entries(cost.materials)) {
      if ((save.materials?.[mat] ?? 0) < qty) {
        await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
        return { error: `insufficient ${mat}`, code: 'INSUFFICIENT_MATERIALS' };
      }
    }
    const nextMaterials = { ...save.materials };
    for (const [mat, qty] of Object.entries(cost.materials)) nextMaterials[mat] = (nextMaterials[mat] ?? 0) - qty;
    const nextInv = { ...(save.equipmentInv ?? {}), [instanceId]: instanceAfter };
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      materials: nextMaterials,
      equipmentInv: nextInv,
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // 改档已落 → 扣金币（idemKey 幂等）+ 镜像。扣币失败（并发耗尽）只是少扣，强化已成立（§6.2）。
      const saveFinal = await settleEnhanceCoins(cols, commercial, now, accountId, idempotencyKey, cost.coins);
      return { success, instance: instanceAfter, save: saveFinal };
    }
    // rev 冲突 → 重读重试
  }
  // 改档失败（金币未动）→ 释放抢占，客户端可安全重试。
  await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/** 扣强化金币（commercial 权威，orderId=idemKey 幂等）+ 写镜像；commercial 不可用/失败则镜像不动。 */
async function settleEnhanceCoins(
  cols: Collections,
  commercial: CommercialClient,
  now: () => number,
  accountId: string,
  idempotencyKey: string,
  coins: number,
): Promise<SaveData> {
  if (coins > 0 && commercial.available) {
    const charge = await commercial.spend({ accountId, amount: coins, reason: 'equip_enhance', orderId: idempotencyKey });
    if (charge.ok) return mirrorCoins(cols, accountId, charge.coinsAfter, now());
  }
  return getOrCreateSave(cols, accountId, now());
}

/**
 * 分解一批装备（EQUIPMENT_DESIGN §6.3，ADR-012）：返还 70% 打造材料、移出库存。
 * +5 及以上不可分解（NOT_SALVAGEABLE）；穿戴中（EQUIP_IN_USE）/ 锁定（EQUIP_LOCKED）拒。
 * 全批先校验、任一不合规整批拒（不留半完成态），再单原子写（移实例 + 入材料）。idemKey 幂等。
 */
export async function salvageEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  instanceIds: string[],
  idempotencyKey: string,
): Promise<{ refunded: Record<string, number>; save: SaveData } | EquipError> {
  if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
    return { error: 'instanceIds required', code: 'BAD_REQUEST' };
  }
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };

  const replay = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'salvage') {
    const r = replay.result as { refunded: Record<string, number> };
    return { refunded: r.refunded, save: await getOrCreateSave(cols, accountId, now()) };
  }

  const ids = [...new Set(instanceIds)];
  // 校验 + 累计返还（用当前存档；rev 循环内复查存在性）。
  const cur = await getOrCreateSave(cols, accountId, now());
  const refunded: Record<string, number> = {};
  for (const id of ids) {
    const inst = cur.equipmentInv?.[id];
    if (!inst) return { error: `equipment instance not found: ${id}`, code: 'EQUIP_NOT_FOUND' };
    if (inst.locked) return { error: `equipment locked: ${id}`, code: 'EQUIP_LOCKED' };
    if (isEquipped(cur, id)) return { error: `equipment in use: ${id}`, code: 'EQUIP_IN_USE' };
    if (inst.level > SALVAGE_MAX_LEVEL) return { error: `not salvageable (+${inst.level}): ${id}`, code: 'NOT_SALVAGEABLE' };
    for (const [mat, qty] of Object.entries(salvageRefund(inst.defId))) refunded[mat] = (refunded[mat] ?? 0) + qty;
  }

  // 幂等抢占。
  try {
    await cols.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'salvage',
      result: { refunded },
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      const r = prev?.result as { refunded: Record<string, number> };
      return { refunded: r.refunded, save: await getOrCreateSave(cols, accountId, now()) };
    }
    throw e;
  }

  // 原子写：移实例 + 入材料（rev 守卫，循环内复查全部仍在且仍可分解）。
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    const save = doc.save;
    for (const id of ids) {
      const inst = save.equipmentInv?.[id];
      if (!inst || inst.locked || isEquipped(save, id) || inst.level > SALVAGE_MAX_LEVEL) {
        await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
        return { error: `equipment no longer salvageable: ${id}`, code: 'REV_CONFLICT' };
      }
    }
    const nextInv = { ...(save.equipmentInv ?? {}) };
    for (const id of ids) delete nextInv[id];
    const nextMaterials = { ...save.materials };
    for (const [mat, qty] of Object.entries(refunded)) nextMaterials[mat] = (nextMaterials[mat] ?? 0) + qty;
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      materials: nextMaterials,
      equipmentInv: nextInv,
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { refunded, save: next };
  }
  await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

// ── E4 穿戴（EQUIPMENT_DESIGN §3.4 / §18）──────────────────────────────────────

/**
 * 穿戴 / 卸下一件装备（EQUIPMENT_DESIGN §3.4）。纯状态、无随机、无资源 → 天然幂等，无需 idemKey。
 * instanceId=null 卸下该槽；否则校验实例存在 + 定义槽位匹配（INVALID_SLOT）。
 * unitType 缺省 → 写 gear.global（阶段一全军共享）；给定 → 写 gear.byUnit[unitType]（阶段二按兵种）。
 * 战斗中冻结由客户端/结算保证（§3.4），服务端只管状态。
 */
export async function equipEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  slot: string,
  instanceId: string | null,
  unitType?: string,
): Promise<{ save: SaveData } | EquipError> {
  if (!EQUIP_SLOTS.includes(slot as EquipSlot)) return { error: 'invalid slot', code: 'INVALID_SLOT' };

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;

    if (instanceId !== null) {
      const inst = save.equipmentInv?.[instanceId];
      if (!inst) return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
      const def = EQUIPMENT_DEFS[inst.defId];
      if (def && def.slot !== slot) return { error: `slot mismatch: ${inst.defId} is ${def.slot}`, code: 'INVALID_SLOT' };
    }

    const gear: GearLoadout = JSON.parse(JSON.stringify(save.gear ?? {}));
    const map = unitType
      ? ((gear.byUnit ??= {})[unitType] ??= {})
      : (gear.global ??= {});
    if (instanceId === null) delete (map as Record<string, string | undefined>)[slot];
    else (map as Record<string, string>)[slot] = instanceId;

    const next: SaveData = { ...save, rev: save.rev + 1, updatedAt: now(), gear };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { save: next };
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}
