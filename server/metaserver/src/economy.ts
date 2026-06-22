// 经济编排辅助（S5-5）。meta 据 commercial 回执发物品（inventory，meta 权威）+ 写钱包镜像 + 对账。
// 关键不变量：
//  • 发货幂等——save.deliveredOrders 记 orderId，$addToSet 天然去重；皮肤是 set，重发不重复给。
//  • 钱包镜像——wallet.coins / gacha.pity 权威在 commercial，meta 只在回执后写镜像段供离线展示。
//  • 重复转化（退币/碎片）S5 暂缓（§4.3 退币额待定 + 补发重算非幂等），只发新皮肤；通道在 commercial 已备。
import type { Collections, SaveData, Rarity, EquipmentInstance } from '@nw/shared';
import { grantCards, deriveUnitLevels, UNIT_CARD_POOL_ID, EQUIPMENT_DEFS, GACHA_MATERIAL_GRANTS, makeGachaEquipInstance, EQUIPMENT_INV_CAP, equipmentInvCount } from '@nw/shared';
import type { CommercialClient, GachaResultEntry } from './commercialClient.js';

/** 逐结果标记是否重复（对照当前库存 + 同批已发，供客户端展示开箱）。 */
export function markDuplicates(
  ownedSkins: string[],
  results: GachaResultEntry[],
): { newSkins: string[]; marked: { itemId: string; rarity: Rarity; duplicate: boolean }[] } {
  const owned = new Set(ownedSkins);
  const newSkins: string[] = [];
  const marked = results.map((r) => {
    const duplicate = owned.has(r.itemId);
    if (!duplicate) {
      owned.add(r.itemId);
      newSkins.push(r.itemId);
    }
    return { itemId: r.itemId, rarity: r.rarity, duplicate };
  });
  return { newSkins, marked };
}

/**
 * 发货 + 钱包镜像，单文档原子且幂等（deliveredOrders $addToSet 去重）。
 * 返回更新后的存档；orderId 已发过则返回当前存档（不重复发）。
 * E7 扩展：可选 materialInc（材料增量）+ equipInstances（装备实例 map），同笔原子写入。
 */
export async function deliverGrant(
  cols: Collections,
  accountId: string,
  orderId: string,
  newSkins: string[],
  coinsAfter: number,
  pityPatch: Record<string, number> | null,
  now: number,
  materialInc?: Record<string, number>,
  equipInstances?: Record<string, EquipmentInstance>,
): Promise<SaveData> {
  const set: Record<string, unknown> = {
    'save.updatedAt': now,
    'save.wallet.coins': coinsAfter,
  };
  if (pityPatch) {
    for (const [pool, v] of Object.entries(pityPatch)) set[`save.gacha.pity.${pool}`] = v;
  }
  // 装备实例逐条 $set（不受 300 cap，盲盒有意获得；满仓溢出后续 §13 邮件暂存）。
  for (const [id, inst] of Object.entries(equipInstances ?? {})) set[`save.equipmentInv.${id}`] = inst;
  const inc: Record<string, number> = { 'save.rev': 1, rev: 1 };
  for (const [mat, qty] of Object.entries(materialInc ?? {})) if (qty > 0) inc[`save.materials.${mat}`] = qty;
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId },
    {
      $addToSet: {
        'save.inventory.skins': { $each: newSkins },
        'save.deliveredOrders': orderId,
      },
      $inc: inc,
      $set: set,
    },
    { returnDocument: 'after' },
  );
  if (res) return res.save;
  const cur = await cols.saves.findOne({ _id: accountId });
  if (!cur) throw new Error('save missing after grant');
  return cur.save;
}

/**
 * 单位卡盲盒发货（S12-C，独立单位卡池）：把 cardGrants（cardKey→张数）入 cardInventory +
 * 重算 unitLevels（服务器权威，引擎读此跑蓝图）。**乐观锁 read-modify-write**（rev CAS + 重试，
 * 同 service.mutateSave）——因 unitLevels = deriveUnitLevels(cardInventory) 是派生值，无法用单次
 * $inc 表达，须在内存重算。幂等：deliveredOrders 已含 orderId 则直接返回当前 save（防 $inc 重复加，
 * 比皮肤 set 更需此守卫）。同笔顺带写钱包镜像 + pity（与皮肤池 deliverGrant 对称）。
 */
export async function deliverCardGrant(
  cols: Collections,
  accountId: string,
  orderId: string,
  cardGrants: Record<string, number>,
  coinsAfter: number,
  pityPatch: Record<string, number> | null,
  now: number,
): Promise<SaveData> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) throw new Error('save missing before card grant');
    if (doc.save.deliveredOrders?.includes(orderId)) return doc.save; // 幂等：已发过不重复 $inc
    const cardInventory = grantCards(doc.save.cardInventory ?? {}, cardGrants);
    const unitLevels = deriveUnitLevels(cardInventory);
    const set: Record<string, unknown> = {
      'save.updatedAt': now,
      'save.wallet.coins': coinsAfter,
      'save.cardInventory': cardInventory,
      'save.unitLevels': unitLevels,
    };
    if (pityPatch) {
      for (const [pool, v] of Object.entries(pityPatch)) set[`save.gacha.pity.${pool}`] = v;
    }
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      {
        $addToSet: { 'save.deliveredOrders': orderId },
        $inc: { 'save.rev': 1, rev: 1 },
        $set: set,
      },
      { returnDocument: 'after' },
    );
    if (res) return res.save;
    // rev 冲突（并发 PUT equipped/flags 或并发 pve 写）→ 重读重试。
  }
  throw new Error('rev conflict delivering card grant');
}

/**
 * 邮件附件发货（S6-3）：单文档原子 + 幂等（deliveredOrders $addToSet 去重）。
 * 皮肤进 inventory.skins（set 去重）、物品 $inc inventory.items.{id}、材料 $inc materials.{id}
 * （养成统一池，SLG8 赛季奖励等）、金币写镜像（coinsAfter 非 null 时）。
 * `orderId` = mail.claimOrderId；重发同 orderId 不重复加物品（$addToSet 去重 + 金币以 commercial 权威镜像）。
 */
export async function deliverMailGrant(
  cols: Collections,
  accountId: string,
  orderId: string,
  newSkins: string[],
  itemInc: Record<string, number>,
  coinsAfter: number | null,
  now: number,
  materialInc: Record<string, number> = {},
): Promise<SaveData> {
  const set: Record<string, unknown> = { 'save.updatedAt': now };
  if (coinsAfter !== null) set['save.wallet.coins'] = coinsAfter;
  const inc: Record<string, number> = { 'save.rev': 1, rev: 1 };
  for (const [id, n] of Object.entries(itemInc)) if (n > 0) inc[`save.inventory.items.${id}`] = n;
  for (const [id, n] of Object.entries(materialInc)) if (n > 0) inc[`save.materials.${id}`] = n;
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId },
    {
      $addToSet: {
        'save.inventory.skins': { $each: newSkins },
        'save.deliveredOrders': orderId,
      },
      $inc: inc,
      $set: set,
    },
    { returnDocument: 'after' },
  );
  if (res) return res.save;
  const cur = await cols.saves.findOne({ _id: accountId });
  if (!cur) throw new Error('save missing after mail grant');
  return cur.save;
}

/** 仅刷新钱包镜像（充值/广告：无物品发货，只回写余额）。 */
export async function mirrorCoins(
  cols: Collections,
  accountId: string,
  coins: number,
  now: number,
): Promise<SaveData> {
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId },
    { $inc: { 'save.rev': 1, rev: 1 }, $set: { 'save.wallet.coins': coins, 'save.updatedAt': now } },
    { returnDocument: 'after' },
  );
  if (res) return res.save;
  const cur = await cols.saves.findOne({ _id: accountId });
  if (!cur) throw new Error('save missing after mirror');
  return cur.save;
}

/** 从 commercial 拉权威余额 + pity 写镜像（GET /save 顺带刷新）。 */
export async function mirrorWalletFrom(
  cols: Collections,
  accountId: string,
  coins: number,
  pity: Record<string, number>,
  now: number,
): Promise<SaveData> {
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId },
    {
      $inc: { 'save.rev': 1, rev: 1 },
      $set: { 'save.wallet.coins': coins, 'save.gacha.pity': pity, 'save.updatedAt': now },
    },
    { returnDocument: 'after' },
  );
  if (res) return res.save;
  const cur = await cols.saves.findOne({ _id: accountId });
  if (!cur) throw new Error('save missing after wallet mirror');
  return cur.save;
}

/** 一笔未发货订单的发货闭环（皮肤幂等 + 标 delivered）。供对账复用。 */
async function deliverOrder(
  cols: Collections,
  commercial: CommercialClient,
  accountId: string,
  order: {
    _id: string;
    kind: 'shop' | 'gacha';
    result: { itemId?: string; results?: GachaResultEntry[]; poolId?: string };
  },
  coinsAfter: number,
  pityPatch: Record<string, number> | null,
  now: number,
): Promise<SaveData> {
  // 单位卡池订单（S12-C）：results.itemId 是 cardKey，入 cardInventory（不当皮肤）。
  if (order.kind === 'gacha' && order.result.poolId === UNIT_CARD_POOL_ID) {
    const cardGrants: Record<string, number> = {};
    for (const r of order.result.results ?? []) cardGrants[r.itemId] = (cardGrants[r.itemId] ?? 0) + 1;
    const save = await deliverCardGrant(cols, accountId, order._id, cardGrants, coinsAfter, pityPatch, now);
    await commercial.orderDelivered({ orderId: order._id });
    return save;
  }

  const cur = await cols.saves.findOne({ _id: accountId });
  const owned = cur?.save.inventory.skins ?? [];
  const invCount = equipmentInvCount(cur?.save.equipmentInv);

  // 商店直购：kind='item' → inventory.items；kind='skin' → skins（沿用现有路径）。
  if (order.kind === 'shop' && order.result.itemId) {
    const itemId = order.result.itemId;
    if (itemId.startsWith('mat_') && GACHA_MATERIAL_GRANTS[itemId]) {
      // 商店材料（未来扩展），当前无此品类，走 fallback 皮肤路径
    } else if (EQUIPMENT_DEFS[itemId]) {
      // 商店装备（未来扩展）
    } else if (!owned.includes(itemId)) {
      // 普通皮肤直购
      const save = await deliverGrant(cols, accountId, order._id, [itemId], coinsAfter, pityPatch, now);
      await commercial.orderDelivered({ orderId: order._id });
      return save;
    } else {
      const save = await deliverGrant(cols, accountId, order._id, [], coinsAfter, pityPatch, now);
      await commercial.orderDelivered({ orderId: order._id });
      return save;
    }
    // kind='item'：写 inventory.items（保护道具等消耗品，E7）。
    const itemInc: Record<string, number> = { [itemId]: 1 };
    const save = await deliverMailGrant(cols, accountId, order._id, [], itemInc, coinsAfter, now);
    await commercial.orderDelivered({ orderId: order._id });
    return save;
  }

  // 盲盒：按结果 itemId 分流 — mat_* → 材料，装备 defId → 装备实例，其他 → 皮肤。
  const results = order.result.results ?? [];
  const skinResults: GachaResultEntry[] = [];
  const materialInc: Record<string, number> = {};
  const equipInstances: Record<string, EquipmentInstance> = {};

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const matGrant = GACHA_MATERIAL_GRANTS[r.itemId];
    if (matGrant) {
      // 材料格
      for (const [mat, qty] of Object.entries(matGrant)) materialInc[mat] = (materialInc[mat] ?? 0) + qty;
    } else if (EQUIPMENT_DEFS[r.itemId]) {
      // 装备格：跳过满仓（300 上限，静默跳过；满仓补偿 §13 后续再做）
      if (invCount + Object.keys(equipInstances).length < EQUIPMENT_INV_CAP) {
        const instanceId = `eq_gacha_${order._id}_${i}`;
        equipInstances[instanceId] = makeGachaEquipInstance(r.itemId, instanceId) as EquipmentInstance;
      }
    } else {
      skinResults.push(r);
    }
  }

  const { newSkins } = markDuplicates(owned, skinResults);
  const hasMixed = Object.keys(materialInc).length > 0 || Object.keys(equipInstances).length > 0;
  const save = await deliverGrant(
    cols, accountId, order._id, newSkins, coinsAfter, pityPatch, now,
    hasMixed ? materialInc : undefined,
    hasMixed ? equipInstances : undefined,
  );
  await commercial.orderDelivered({ orderId: order._id });
  return save;
}

/**
 * 对账：拉该账号未发货订单（commercial），逐笔补发 + 标 delivered。
 * GET /save 顺带调用；崩溃在「扣币后、发货前」的订单据此收敛（皮肤幂等，不丢不重）。
 */
export async function reconcileUndelivered(
  cols: Collections,
  commercial: CommercialClient,
  accountId: string,
  now: number,
): Promise<void> {
  const orders = await commercial.undeliveredOrders(accountId);
  for (const o of orders) {
    // 补发用 commercial 拉回的权威余额做镜像（不再二次扣币）。
    const w = await commercial.getWallet(accountId);
    const pityPatch =
      o.kind === 'gacha' && o.result.poolId && w
        ? { [o.result.poolId]: w.pity[o.result.poolId] ?? 0 }
        : null;
    await deliverOrder(cols, commercial, accountId, o, w?.coins ?? 0, pityPatch, now);
  }
}

/** UTC 自然日 key（广告 cap 重置）。注入 now 便于测试。 */
export function adsDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * 广告 cap：原子自增当日计数，超过 cap 返回 false（不发）。
 * 用 _id=`${accountId}:${dayKey}` 文档的 $inc + 守卫 count<cap。
 */
export async function bumpAdsCap(
  cols: Collections,
  accountId: string,
  dayKey: string,
  cap: number,
  now: number,
): Promise<boolean> {
  const id = `${accountId}:${dayKey}`;
  // 先 upsert 保证文档存在，再带守卫 $inc。
  await cols.adsDaily.updateOne(
    { _id: id },
    { $setOnInsert: { _id: id, accountId, dayKey, count: 0, ts: now } },
    { upsert: true },
  );
  const res = await cols.adsDaily.findOneAndUpdate(
    { _id: id, count: { $lt: cap } },
    { $inc: { count: 1 }, $set: { ts: now } },
    { returnDocument: 'after' },
  );
  return !!res;
}
