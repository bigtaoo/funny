// Shop catalog + purchase (S5). Split out of service/economy.ts (2026-08-10, 独立函数模块 form — see
// economy.ts's facade comment). `shopBuyHandler` takes `core: MetaCore` directly (2026-08-11 ctx-bind
// cleanup — see base.ts's header, for `core.ensureCommercial`); `getShopItemsHandler` only ever touches
// `deps` so it takes that directly, no `core` needed. No behavior change.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ErrorCode, err, ok, SHOP_ITEMS, findShopItem, MATERIAL_SHOP_DAILY_CAP, SHOP_BUY_MAX_QTY,
  bumpCappedCounter, readCounterField,
} from '@nw/shared';
import { deliverOrder, adsDayKey } from '../../economy.js';
import { nullMetaSocialsvcClient } from '../../socialsvcClient.js';
import { accountIdOf, clientPlatformOf, type ServiceDeps, type MetaCore } from '../base.js';

/**
 * Shop item list (catalog single source of truth: @nw/shared). Material bundles carry the
 * account's live daily-cap progress (dailyLimit/purchasedToday) so the client can show
 * "used/cap" and grey out the Buy button once reached, instead of only finding out from a
 * failed purchase (shopBuy checks the same MATERIAL_SHOP_DAILY_CAP + readCounterField pairing).
 */
export async function getShopItemsHandler(deps: ServiceDeps, req: FastifyRequest) {
  const accountId = accountIdOf(req);
  const { now, redis } = deps;
  const dayKey = adsDayKey(now());
  const items = await Promise.all(SHOP_ITEMS.map(async (i) => {
    const dailyLimit = MATERIAL_SHOP_DAILY_CAP[i.id];
    const purchasedToday = dailyLimit !== undefined
      ? await readCounterField(redis, 'shopMatDaily', accountId, dayKey, i.id)
      : undefined;
    return {
      id: i.id,
      cost: i.cost,
      kind: i.kind,
      grants: i.grants,
      ...(i.qty !== undefined ? { qty: i.qty } : {}),
      ...(dailyLimit !== undefined ? { dailyLimit, purchasedToday } : {}),
    };
  }));
  return ok({ items });
}

/**
 * `qty` (default 1, capped at SHOP_BUY_MAX_QTY, 2026-08-10): buy several units in one request instead
 * of the client looping `qty` sequential calls (the old "×10" button fired 10 full round-trips —
 * client→meta→redis + meta→commercial→Mongo + meta→Mongo — serially, which is what made it visibly
 * slower than every other single-shot shop action). All-or-nothing: a daily cap that can't fit the
 * whole qty, or a balance that can't cover it, rejects the entire request and charges nothing —
 * matches what the client's "can I afford qty×cost" affordability gate already assumes, so no
 * partial-fulfillment bookkeeping is needed here.
 */
export async function shopBuyHandler(core: MetaCore, req: FastifyRequest, reply: FastifyReply) {
  if (!core.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { itemId, qty: rawQty } = req.body as { itemId: string; qty?: number };
  const qty = Number.isInteger(rawQty) && (rawQty as number) >= 1
    ? Math.min(rawQty as number, SHOP_BUY_MAX_QTY)
    : 1;
  const def = findShopItem(itemId);
  if (!def) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown item'));

  const { cols, commercial, now, redis } = core.deps;

  // Material shop bundles (gold→material exchange, ECONOMY_NUMBERS §6.5) carry a daily purchase cap —
  // checked (and claimed, for the FULL qty at once) before charging coins, so a capped-out attempt
  // never touches the wallet. bumpCappedCounter rolls the whole `by` back on overshoot (never a
  // partial bump), so a qty that doesn't fit the remaining daily allowance is rejected outright.
  if (def.kind === 'material') {
    const cap = MATERIAL_SHOP_DAILY_CAP[itemId];
    if (cap !== undefined) {
      const dayKey = adsDayKey(now());
      const allowed = await bumpCappedCounter(redis, 'shopMatDaily', accountId, dayKey, itemId, cap, qty);
      if (!allowed) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'daily material purchase cap reached'));
    }
  }

  const orderId = randomUUID();
  const charge = await commercial.shopCharge({ accountId, itemId, cost: def.cost, qty, orderId, clientPlatform: clientPlatformOf(req) });
  if (!charge.ok) {
    if (charge.error === 'INSUFFICIENT_FUNDS') {
      return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
    }
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, charge.error));
  }
  // Delivery: route by the item's declared kind (skin vs. inventory.items vs. materials) + mark
  // delivered + mirror wallet. `itemId` here MUST be the shop catalog id (not `def.grants`) —
  // deliverOrder re-resolves `findShopItem(itemId)` internally to decide the routing; passing
  // `def.grants` was a latent bug that stayed invisible as long as every SHOP_ITEMS entry had
  // grants === id (true for skins/protect_enhance, false for the mat_buy_* material bundles,
  // which is what surfaced it — a lookup for e.g. 'scrap' finds no shop item and silently falls
  // through to the skin-grant path instead of the material path).
  const { save } = await deliverOrder(
    cols, commercial, core.deps.socialsvc ?? nullMetaSocialsvcClient, accountId,
    { _id: orderId, kind: 'shop', result: { itemId, qty } },
    charge.coinsAfter, null, now(),
  );
  return ok({ save, granted: def.grants });
}
