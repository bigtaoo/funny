// Economy handlers (S5): meta orchestrates → commercial deducts/randomizes → delivery → mirror
// push-back. Shop, gacha pools/draw, fate redemption, monthly/year subscription cards, starter packs,
// rewarded ads, IAP receipt verification, and promo codes.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ErrorCode,
  err,
  ok,
  SHOP_ITEMS,
  GACHA_POOLS,
  findShopItem,
  poolEntries,
  gachaCost,
  buildLimitedPool,
  customPoolEntries,
  customPoolCostTen,
  ADS_REWARD_COINS,
  ADS_DAILY_CAP,
  ADS_MIN_INTERVAL_MS,
  PRODUCT_STARTER_GROWTH,
  GROWTH_PACK_WINDOW_DAYS,
  accrueRetentionTask,
  type GachaPoolDef,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { accrueEventTask } from '../events.js';
import { verifyAdPlatformToken } from '../ads.js';
import type { GachaPoolView } from '../commercialClient.js';
import {
  markDuplicates,
  deliverGrant,
  deliverOrder,
  mirrorCoins,
  mirrorWalletFrom,
  adsDayKey,
  bumpAdsCap,
  hashAdToken,
  recordAdToken,
  checkAdInterval,
} from '../economy.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, type Constructor, type MetaBaseCtor } from './base.js';

type EconomyHandlers = Pick<
  MetaHandlers,
  | 'getShopItems' | 'getGachaPools' | 'shopBuy' | 'gachaDraw' | 'redeemFate'
  | 'monthlyCardBuy' | 'yearCardBuy' | 'monthlyCardClaim' | 'starterBuy'
  | 'adsReward' | 'iapVerify' | 'redeemPromoCode'
>;

/** Map a commercial subscription-card error to a client error code (single-slot gate surfaces ALREADY_ACTIVE; else BAD_REQUEST). */
function subscriptionErrCode(error: string): ErrorCode {
  return error === 'ALREADY_ACTIVE' ? ErrorCode.ALREADY_ACTIVE : ErrorCode.BAD_REQUEST;
}

/** Client-facing gacha pool view (GACHA_DESIGN §2 + §8): static + active limited pools with per-entry odds. */
interface PoolView {
  id: string;
  costSingle: number;
  costTen: number;
  pityThreshold: number;
  dupePolicy: string;
  limited?: boolean;
  name?: string;
  featuredLegendary?: string;
  endAt?: number;
  entries: { itemId: string; weight: number; rarity: string; probability: number }[];
}

export function EconomyMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<EconomyHandlers> {
  return class extends Base {
    /** Shop item list (catalog single source of truth: @nw/shared). */
    async getShopItems() {
      const items = SHOP_ITEMS.map((i) => ({
        id: i.id,
        cost: i.cost,
        kind: i.kind,
        grants: i.grants,
      }));
      return ok({ items });
    }

    /** Gacha pool list (entries expanded for client display). Includes active limited pools (GACHA_DESIGN §2.2) with banner metadata. */
    async getGachaPools() {
      const { commercial, now } = this.deps;
      const toView = (p: GachaPoolDef, name?: string): PoolView => {
        const entries = poolEntries(p);
        const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
        return {
          id: p.id,
          costSingle: p.costSingle,
          costTen: p.costTen,
          pityThreshold: p.pityThreshold,
          dupePolicy: p.dupePolicy,
          // Limited pool banner metadata (absent on static pools).
          ...(p.limited
            ? { limited: true, name, featuredLegendary: p.featuredLegendary, endAt: p.endAt }
            : {}),
          // C5-a: each entry includes a probability field (required by Apple 3.1.1).
          entries: entries.map((e) => ({
            ...e,
            probability: totalWeight > 0 ? e.weight / totalWeight : 0,
          })),
        };
      };
      // Build a client view for an ops-authored custom pool (§12): its own cost/entries, no pity/featured.
      const customToView = (cfg: Extract<GachaPoolView, { kind: 'custom' }>): PoolView => {
        const entries = customPoolEntries(cfg);
        const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
        return {
          id: cfg.id,
          costSingle: cfg.costSingle,
          costTen: customPoolCostTen(cfg),
          pityThreshold: 0, // custom pools have no pity
          dupePolicy: 'coins',
          limited: true,
          name: cfg.name,
          endAt: cfg.endAt,
          entries: entries.map((e) => ({ ...e, probability: totalWeight > 0 ? e.weight / totalWeight : 0 })),
        };
      };
      const pools: PoolView[] = GACHA_POOLS.map((p) => toView(p));
      // Append active limited pools (best-effort; if commercial is down the client still gets the static pools).
      if (commercial.available) {
        try {
          const active = await commercial.listActiveLimitedPools(now());
          for (const cfg of active) {
            if (cfg.kind === 'custom') pools.push(customToView(cfg));
            else pools.push(toView(buildLimitedPool(cfg), cfg.name));
          }
        } catch {
          /* best-effort: static pools already returned */
        }
      }
      return ok({ pools });
    }

    async shopBuy(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { itemId } = req.body as { itemId: string };
      const def = findShopItem(itemId);
      if (!def) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown item'));

      const { cols, commercial, now } = this.deps;
      const orderId = randomUUID();
      const charge = await commercial.shopCharge({ accountId, itemId, cost: def.cost, orderId });
      if (!charge.ok) {
        if (charge.error === 'INSUFFICIENT_FUNDS') {
          return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
        }
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, charge.error));
      }
      // Delivery: idempotently add skin to inventory + mark as delivered + mirror wallet.
      const cur = await getOrCreateSave(cols, accountId, now());
      const newSkins = cur.inventory.skins.includes(def.grants) ? [] : [def.grants];
      const save = await deliverGrant(cols, accountId, orderId, newSkins, charge.coinsAfter, null, now());
      await commercial.orderDelivered({ orderId });
      return ok({ save, granted: def.grants });
    }

    async gachaDraw(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { poolId, count } = req.body as { poolId: string; count: number };
      // Static pools validate here; limited pools exist only in commercial (validated there → POOL_UNAVAILABLE).
      if (count !== 1 && count !== 10) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid count'));
      }
      void gachaCost; // cost is authoritative in commercial (computed per pool); here we only validate the draw count.

      const { cols, commercial, now } = this.deps;
      const orderId = randomUUID();
      const draw = await commercial.gachaDraw({ accountId, poolId, count, orderId });
      if (!draw.ok) {
        if (draw.error === 'INSUFFICIENT_FUNDS') {
          return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
        }
        if (draw.error === 'POOL_UNAVAILABLE') {
          return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'pool unavailable'));
        }
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, draw.error));
      }
      // Skin/standard pool delivery: new skins added to inventory.skins (idempotent); duplicate-to-coin conversion
      // deferred to S5 (see economy.ts comment). (The separate unit-card pool + its cardInventory delivery branch were
      // removed on 2026-07-03; unit cards now come only from PvE level drops.)
      const cur = await getOrCreateSave(cols, accountId, now());
      const { newSkins, marked } = markDuplicates(cur.inventory.skins, draw.results);
      const save = await deliverGrant(
        cols,
        accountId,
        orderId,
        newSkins,
        draw.coinsAfter,
        { [poolId]: draw.pityAfter },
        now(),
      );
      await commercial.orderDelivered({ orderId });
      // B5: record daily task "open gacha"; merge retention into the returned save so the client immediately sees task completion.
      await this.bumpRetentionTask(accountId, 'gacha.draw');
      const nextRetention2 = accrueRetentionTask(save.retention, 'gacha.draw', now());
      let saveWithRet2 = nextRetention2 !== save.retention ? { ...save, retention: nextRetention2 } : save;
      // Fate points (§7): reflect the freshly-credited balance immediately (mirror catches up fully on next GET /save).
      if (draw.fateGained > 0) {
        saveWithRet2 = {
          ...saveWithRet2,
          monetization: {
            fatePoints: draw.fatePointsAfter,
            subscriptionExpiry: saveWithRet2.monetization?.subscriptionExpiry ?? 0,
            starterUsed: saveWithRet2.monetization?.starterUsed ?? [],
          },
        };
      }
      return ok({ save: saveWithRet2, results: marked });
    }

    /** Fate Point redemption (GACHA_DESIGN §7): 30 points → one self-chosen past-featured legendary skin. */
    async redeemFate(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { itemId } = req.body as { itemId: string };
      if (!itemId) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing itemId'));

      const { cols, commercial, now } = this.deps;
      const orderId = randomUUID();
      const r = await commercial.redeemFate({ accountId, itemId, orderId });
      if (!r.ok) {
        if (r.error === 'FATE_INSUFFICIENT') {
          return reply.code(402).send(err(ErrorCode.FATE_INSUFFICIENT, 'not enough fate points'));
        }
        if (r.error === 'FATE_INVALID_ITEM') {
          return reply.code(400).send(err(ErrorCode.FATE_INVALID_ITEM, 'not a featured legendary'));
        }
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, r.error));
      }
      await getOrCreateSave(cols, accountId, now());
      // Deliver the chosen skin idempotently (shared routing), then reflect the new fate balance immediately.
      let save = await deliverOrder(
        cols, commercial, accountId,
        { _id: orderId, kind: 'fate', result: { itemId } },
        r.coinsAfter, null, now(),
      );
      save = {
        ...save,
        monetization: {
          fatePoints: r.fatePointsAfter,
          subscriptionExpiry: save.monetization?.subscriptionExpiry ?? 0,
          starterUsed: save.monetization?.starterUsed ?? [],
        },
      };
      return ok({ save, granted: itemId });
    }

    /** Buy the monthly card (GACHA_DESIGN §5). Single-slot: ALREADY_ACTIVE while a card is still running. Real IAP verification is out of scope here (treated as authorized). */
    async monthlyCardBuy(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { cols, commercial, now } = this.deps;
      const orderId = randomUUID();
      const r = await commercial.monthlyCardBuy({ accountId, orderId });
      if (!r.ok) return reply.code(400).send(err(subscriptionErrCode(r.error), r.error));
      const w = await commercial.getWallet(accountId);
      const save = w
        ? await mirrorWalletFrom(cols, accountId, w, now())
        : await getOrCreateSave(cols, accountId, now());
      return ok({ save });
    }

    /** Buy the year card (GACHA_DESIGN §5): 365-day subscription, same single-slot gate + daily claim as the monthly card. */
    async yearCardBuy(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { cols, commercial, now } = this.deps;
      const orderId = randomUUID();
      const r = await commercial.yearCardBuy({ accountId, orderId });
      if (!r.ok) return reply.code(400).send(err(subscriptionErrCode(r.error), r.error));
      const w = await commercial.getWallet(accountId);
      const save = w
        ? await mirrorWalletFrom(cols, accountId, w, now())
        : await getOrCreateSave(cols, accountId, now());
      return ok({ save });
    }

    /** Claim the monthly card's daily coins (GACHA_DESIGN §5): once per UTC day while the subscription is active. */
    async monthlyCardClaim(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { cols, commercial, now } = this.deps;
      const dayKey = adsDayKey(now());
      const r = await commercial.monthlyCardClaim({ accountId, dayKey });
      if (!r.ok) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, r.error));
      const w = await commercial.getWallet(accountId);
      const save = w
        ? await mirrorWalletFrom(cols, accountId, w, now())
        : await getOrCreateSave(cols, accountId, now());
      return ok({ save, claimed: r.claimed });
    }

    /** Buy a starter pack (GACHA_DESIGN §6): starter_draw (rare+ floored 10-pull) or starter_growth (coins + 7-day card). */
    async starterBuy(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { productId } = req.body as { productId: string };
      const { cols, commercial, now } = this.deps;

      // Growth pack: enforce the first-N-days account-age window (best-effort; absent account → allow).
      if (productId === PRODUCT_STARTER_GROWTH) {
        const acct = await cols.accounts.findOne({ _id: accountId });
        if (acct && now() - acct.createdAt > GROWTH_PACK_WINDOW_DAYS * 86400000) {
          return reply.code(403).send(err(ErrorCode.NO_PERMISSION, 'growth pack window closed'));
        }
      }

      const orderId = randomUUID();
      const r = await commercial.starterBuy({ accountId, productId, orderId });
      if (!r.ok) {
        if (r.error === 'ALREADY_PURCHASED') {
          return reply.code(409).send(err(ErrorCode.ALREADY_PURCHASED, 'already purchased'));
        }
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, r.error));
      }

      const before = await getOrCreateSave(cols, accountId, now());
      // Mark new/dup for the reveal BEFORE delivery mutates the skin set (mirrors gachaDraw's convention).
      const marked = markDuplicates(before.inventory.skins, r.results).marked;
      // starter_draw delivers pack items (loot-box routing); starter_growth grants coins/subscription only (no items).
      if (r.results.length > 0) {
        await deliverOrder(
          cols, commercial, accountId,
          { _id: orderId, kind: 'starter', result: { results: r.results, poolId: 'standard' } },
          r.coinsAfter, null, now(),
        );
      }
      // Mirror wallet (coins + monetization: starterUsed / subscription).
      const w = await commercial.getWallet(accountId);
      const save = w
        ? await mirrorWalletFrom(cols, accountId, w, now())
        : await getOrCreateSave(cols, accountId, now());
      return ok({ save, results: marked });
    }

    async adsReward(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { adToken, platform } = req.body as { adToken: string; platform?: string };
      if (!adToken) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing adToken'));

      const { cols, commercial, now } = this.deps;
      const ts = now();
      const dayKey = adsDayKey(ts);

      // 30-minute interval gate (C2).
      const intervalOk = await checkAdInterval(cols, accountId, dayKey, ts, ADS_MIN_INTERVAL_MS);
      if (!intervalOk) {
        return reply.code(429).send(err(ErrorCode.DAILY_CAP_REACHED, 'ad cooldown not elapsed'));
      }

      // Daily cap (C2).
      const allowed = await bumpAdsCap(cols, accountId, dayKey, ADS_DAILY_CAP, ts);
      if (!allowed) {
        return reply.code(429).send(err(ErrorCode.DAILY_CAP_REACHED, 'daily ad cap reached'));
      }

      // Token uniqueness (C2): hash stored in DB; replays are rejected.
      const tokenHash = hashAdToken(adToken);
      const unique = await recordAdToken(cols, tokenHash, accountId, ts);
      if (!unique) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'duplicate adToken'));
      }

      // Platform signature verification (C2): performed for all platforms except dev.
      const plat = platform ?? 'dev';
      if (plat !== 'dev') {
        const sigOk = verifyAdPlatformToken(plat, adToken);
        if (!sigOk) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid ad signature'));
      }

      const credit = await commercial.adsCredit({ accountId, amount: ADS_REWARD_COINS, dayKey });
      if (!credit.ok) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, credit.error));
      const save = await mirrorCoins(cols, accountId, credit.coinsAfter, now());
      // B6: record event task "ad.watch" (best-effort).
      accrueEventTask(cols, accountId, 'ad.watch', now()).catch(() => {});
      return ok({ save, granted: ADS_REWARD_COINS });
    }

    async iapVerify(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { platform, receipt } = req.body as { platform: string; receipt: string };
      if (!platform || !receipt) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing platform/receipt'));
      }
      const { cols, commercial, now } = this.deps;
      // receiptId = unique platform receipt id (idempotency key). The dev stub uses platform:receipt; real channel integration uses the platform transaction id.
      const receiptId = `${platform}:${receipt}`;
      const v = await commercial.rechargeVerify({ accountId, platform, receipt, receiptId });
      if (!v.ok) {
        if (v.error === 'INVALID_RECEIPT') {
          return reply.code(400).send(err(ErrorCode.INVALID_RECEIPT, 'receipt rejected'));
        }
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, v.error));
      }
      const save = await mirrorCoins(cols, accountId, v.coinsAfter, now());
      return ok({ save, granted: v.coinsGranted });
    }

    /** Promo code redemption (B-PROMO): validate → grant coins → push back save. */
    async redeemPromoCode(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { code } = req.body as { code: string };
      if (!code || typeof code !== 'string') {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'code required'));
      }
      const { cols, commercial, now } = this.deps;
      const v = await commercial.promoRedeem({ accountId, code });
      if (!v.ok) {
        const statusMap: Record<string, number> = {
          PROMO_NOT_FOUND: 404,
          PROMO_EXPIRED: 400,
          PROMO_EXHAUSTED: 400,
          PROMO_ALREADY_USED: 400,
        };
        const status = statusMap[v.error] ?? 400;
        return reply.code(status).send(err(ErrorCode.BAD_REQUEST, v.error));
      }
      const save = await mirrorCoins(cols, accountId, v.coinsAfter, now());
      return ok({ coinsAfter: v.coinsAfter, coinsGranted: v.coinsGranted, save });
    }
  };
}
