// Starter pack purchase (GACHA_DESIGN §6). Split out of service/economy.ts (2026-08-10, 独立函数模块
// form — see economy.ts's facade comment). `starterBuyHandler` takes `core: MetaCore` directly
// (2026-08-11 ctx-bind cleanup — see base.ts's header, for `core.ensureCommercial`). No behavior
// change.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok, PRODUCT_STARTER_GROWTH, GROWTH_PACK_WINDOW_DAYS } from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import { markDuplicates, unionOwnershipForDuplicateCheck, deliverOrder, mirrorWalletFrom } from '../../economy.js';
import { nullMetaSocialsvcClient } from '../../socialsvcClient.js';
import { accountIdOf, clientPlatformOf, type MetaCore } from '../base.js';

/**
 * Buy a starter pack (GACHA_DESIGN §6): starter_draw (¥6, rare+ floored 10-pull) or starter_growth
 * (¥30, coins + 7-day card) — both are paid first-purchase-funnel products, not free gifts. Requires
 * a verified store receipt (same gate as monthlyCardBuy/yearCardBuy; previously this endpoint granted
 * both packs on `cost: 0` with no payment at all — see GACHA_DESIGN §6 implementation note).
 */
export async function starterBuyHandler(core: MetaCore, req: FastifyRequest, reply: FastifyReply) {
  if (!core.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { productId, platform, receipt } = req.body as {
    productId: string; platform?: string; receipt?: string;
  };
  if (productId !== PRODUCT_STARTER_GROWTH && productId !== 'starter_draw') {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid productId'));
  }
  if (!platform || !receipt) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing platform/receipt'));
  }
  const { cols, commercial, now } = core.deps;

  // Growth pack: enforce the first-N-days account-age window (best-effort; absent account → allow).
  if (productId === PRODUCT_STARTER_GROWTH) {
    const acct = await cols.accounts.findOne({ _id: accountId });
    if (acct && now() - acct.createdAt > GROWTH_PACK_WINDOW_DAYS * 86400000) {
      return reply.code(403).send(err(ErrorCode.NO_PERMISSION, 'growth pack window closed'));
    }
  }

  const receiptId = `${platform}:${receipt}`;
  const v = await commercial.verifyNonCoinReceipt({
    accountId, platform, receipt, receiptId,
    expectedProduct: productId === PRODUCT_STARTER_GROWTH ? 'starter_growth' : 'starter_draw',
  });
  if (!v.ok) return reply.code(400).send(err(ErrorCode.INVALID_RECEIPT, 'receipt rejected'));

  const orderId = randomUUID();
  const clientPlatform = clientPlatformOf(req);
  const r = await commercial.starterBuy({ accountId, productId, orderId, rechargePlatform: platform, clientPlatform });
  if (!r.ok) {
    if (r.error === 'ALREADY_PURCHASED') {
      return reply.code(409).send(err(ErrorCode.ALREADY_PURCHASED, 'already purchased'));
    }
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, r.error));
  }

  // Mark new/dup for the reveal BEFORE delivery mutates the skin set (mirrors gachaDraw's convention).
  const [before, beforeCardDocs, beforeEquipDocs] = await Promise.all([
    getOrCreateSave(cols, accountId, now()),
    cols.cardInstances.find({ accountId }, { projection: { defId: 1 } }).toArray(),
    cols.equipmentInstances.find({ accountId }, { projection: { defId: 1 } }).toArray(),
  ]);
  const { ownedHero, ownedEquipment, ownedMaterial } = unionOwnershipForDuplicateCheck(
    beforeCardDocs.map((d) => d.defId), beforeEquipDocs.map((d) => d.defId), before,
  );
  const marked = markDuplicates(
    before.inventory.skins, before.everOwned?.skin ?? [], ownedHero, ownedEquipment, ownedMaterial, r.results,
  ).marked;
  // starter_draw delivers pack items (loot-box routing); starter_growth grants coins/subscription only (no items).
  if (r.results.length > 0) {
    await deliverOrder(
      cols, commercial, core.deps.socialsvc ?? nullMetaSocialsvcClient, accountId,
      { _id: orderId, kind: 'starter', result: { results: r.results, poolId: 'standard' } },
      r.coinsAfter, null, now(),
    );
  }
  // Mirror wallet (coins + monetization: starterUsed / subscription). deliverOrder above only marks
  // delivery + writes cards/skins/materials — it never touches coins/pity/subscription, so r.wallet
  // (when the caller populates it) is still authoritative here without a re-fetch.
  const w = r.wallet ?? (await commercial.getWallet(accountId, clientPlatform));
  const save = w
    ? await mirrorWalletFrom(cols, accountId, w, now())
    : await getOrCreateSave(cols, accountId, now());
  return ok({ save, results: marked });
}
