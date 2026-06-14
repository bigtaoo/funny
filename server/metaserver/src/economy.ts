// 经济编排辅助（S5-5）。meta 据 commercial 回执发物品（inventory，meta 权威）+ 写钱包镜像 + 对账。
// 关键不变量：
//  • 发货幂等——save.deliveredOrders 记 orderId，$addToSet 天然去重；皮肤是 set，重发不重复给。
//  • 钱包镜像——wallet.coins / gacha.pity 权威在 commercial，meta 只在回执后写镜像段供离线展示。
//  • 重复转化（退币/碎片）S5 暂缓（§4.3 退币额待定 + 补发重算非幂等），只发新皮肤；通道在 commercial 已备。
import type { Collections, SaveData, Rarity } from '@nw/shared';
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
 */
export async function deliverGrant(
  cols: Collections,
  accountId: string,
  orderId: string,
  newSkins: string[],
  coinsAfter: number,
  pityPatch: Record<string, number> | null,
  now: number,
): Promise<SaveData> {
  const set: Record<string, unknown> = {
    'save.updatedAt': now,
    'save.wallet.coins': coinsAfter,
  };
  if (pityPatch) {
    for (const [pool, v] of Object.entries(pityPatch)) set[`save.gacha.pity.${pool}`] = v;
  }
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId },
    {
      $addToSet: {
        'save.inventory.skins': { $each: newSkins },
        'save.deliveredOrders': orderId,
      },
      $inc: { 'save.rev': 1, rev: 1 },
      $set: set,
    },
    { returnDocument: 'after' },
  );
  if (res) return res.save;
  const cur = await cols.saves.findOne({ _id: accountId });
  if (!cur) throw new Error('save missing after grant');
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
  order: { _id: string; kind: 'shop' | 'gacha'; result: { itemId?: string; results?: GachaResultEntry[] } },
  coinsAfter: number,
  pityPatch: Record<string, number> | null,
  now: number,
): Promise<SaveData> {
  const cur = await cols.saves.findOne({ _id: accountId });
  const owned = cur?.save.inventory.skins ?? [];
  let newSkins: string[];
  if (order.kind === 'shop' && order.result.itemId) {
    newSkins = owned.includes(order.result.itemId) ? [] : [order.result.itemId];
  } else {
    const { newSkins: ns } = markDuplicates(owned, order.result.results ?? []);
    newSkins = ns;
  }
  const save = await deliverGrant(cols, accountId, order._id, newSkins, coinsAfter, pityPatch, now);
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
