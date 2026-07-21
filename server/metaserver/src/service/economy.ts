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
  createLogger,
  claimRechargeReward,
  makeFreshRechargeMilestone,
  type GachaPoolDef,
  type RechargeReward,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { accrueEventTask } from '../events.js';
import { verifyAdPlatformToken } from '../ads.js';
import type { GachaPoolView } from '../commercialClient.js';
import {
  markDuplicates,
  deliverLootBox,
  deliverOrder,
  mirrorCoins,
  mirrorWalletFrom,
  adsDayKey,
  bumpAdsCap,
  hashAdToken,
  recordAdToken,
  checkAdInterval,
} from '../economy.js';
import { nullMetaSocialsvcClient } from '../socialsvcClient.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, type Constructor, type MetaBaseCtor } from './base.js';

const log = createLogger('meta:economy');

type EconomyHandlers = Pick<
  MetaHandlers,
  | 'getShopItems' | 'getGachaPools' | 'shopBuy' | 'gachaDraw' | 'redeemFate'
  | 'monthlyCardBuy' | 'yearCardBuy' | 'monthlyCardClaim' | 'claimRechargeMilestone' | 'starterBuy'
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
      // Delivery: route by the item's declared kind (skin vs. inventory.items) + mark delivered + mirror wallet.
      const { save } = await deliverOrder(
        cols, commercial, this.deps.socialsvc ?? nullMetaSocialsvcClient, accountId,
        { _id: orderId, kind: 'shop', result: { itemId: def.grants } },
        charge.coinsAfter, null, now(),
      );
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
      // getOrCreateSave doesn't depend on the draw result — kick it off alongside the commercial HTTP round-trip
      // instead of waiting for the response first (was serialized, adding a full Mongo round-trip to the critical path).
      const savePromise = getOrCreateSave(cols, accountId, now());
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
      // Route each result: mat_* → materials, equipment defId → equipment instance, character card
      // defId → hero card grant (save.cardInv via grantHeroCards), everything else → skin (idempotent
      // inventory.skins add; duplicate-to-coin conversion deferred to S5, see economy.ts comment).
      // `marked` (new/duplicate badges for the reveal UI) is computed on the full raw result list,
      // checking cards against cardInv defIds (not inventory.skins) since that's where they land.
      const cur = await savePromise;
      const ownedCardDefIds = Object.values(cur.cardInv).map((c) => c.defId);
      const { marked } = markDuplicates(cur.inventory.skins, ownedCardDefIds, draw.results);
      const { save, overflow } = await deliverLootBox(
        cols,
        commercial,
        this.deps.socialsvc ?? nullMetaSocialsvcClient,
        accountId,
        orderId,
        draw.results,
        draw.coinsAfter,
        { [poolId]: draw.pityAfter },
        now(),
      );
      // Bookkeeping-only (marks the order row 'delivered'); not on the critical path. If it fails, the order
      // stays 'charged' and is reconciled on the account's next GET /save via commercial.undeliveredOrders.
      void commercial.orderDelivered({ orderId }).catch((e) => {
        log.warn('gachaDraw: fire-and-forget orderDelivered failed', {
          orderId,
          accountId,
          error: (e as Error).message,
        });
      });
      // B5: record daily task "open gacha" (best-effort, does not block the response — see bumpRetentionTask).
      // The retention state merged into the response below is computed locally, independent of this write landing.
      void this.bumpRetentionTask(accountId, 'gacha.draw');
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
            firstPurchaseUsed: saveWithRet2.monetization?.firstPurchaseUsed,
          },
        };
      }
      return ok({ save: saveWithRet2, results: marked, overflow });
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
      let { save } = await deliverOrder(
        cols, commercial, this.deps.socialsvc ?? nullMetaSocialsvcClient, accountId,
        { _id: orderId, kind: 'fate', result: { itemId } },
        r.coinsAfter, null, now(),
      );
      save = {
        ...save,
        monetization: {
          fatePoints: r.fatePointsAfter,
          subscriptionExpiry: save.monetization?.subscriptionExpiry ?? 0,
          starterUsed: save.monetization?.starterUsed ?? [],
          firstPurchaseUsed: save.monetization?.firstPurchaseUsed,
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

    /**
     * Claim a cumulative-recharge milestone reward (GACHA_DESIGN §13, ADR-045). Progress (totalRechargeCents)
     * is commercial-authoritative and read live from the wallet; claim state lives in save.rechargeMilestone
     * (same split as battle pass's xp(commercial n/a, SaveData-native)/claimedFree(SaveData) — here the
     * progress source is commercial instead). Atomic validate + record claim (optimistic lock prevents
     * double-tap); material rewards are written to save.materials in the same transaction, coins are
     * delivered via commercial.grant afterward (mirrors claimBattlePass).
     */
    async claimRechargeMilestone(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { tierId } = req.body as { tierId: number };
      const { cols, commercial, now } = this.deps;

      const wallet = await commercial.getWallet(accountId);
      if (!wallet) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'wallet unavailable'));

      let claimedRewards: RechargeReward[] | null = null;
      const out = await this.mutateSave(accountId, (s) => {
        const data = s.rechargeMilestone ?? makeFreshRechargeMilestone();
        const r = claimRechargeReward(data, wallet.totalRechargeCents, tierId);
        if (!r.ok) return r.error;
        claimedRewards = r.rewards;
        const next = { ...s, rechargeMilestone: r.data };
        for (const reward of r.rewards) {
          if (reward.kind === 'material' && reward.id && reward.count > 0) {
            next.materials = { ...s.materials, [reward.id]: (s.materials[reward.id] ?? 0) + reward.count };
          }
        }
        return next;
      });
      if ('error' in out) {
        switch (out.error) {
          case 'BAD_REQUEST':
            return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'bad request'));
          case 'NOT_REACHED':
            return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'threshold not reached'));
          case 'ALREADY_CLAIMED':
            return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'already claimed'));
          default:
            return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
        }
      }
      const rewards = claimedRewards!;
      let finalSave = out.save;
      const coinsReward = rewards.find((r) => r.kind === 'coins');
      if (coinsReward && coinsReward.count > 0 && commercial.available) {
        try {
          const orderId = `recharge.claim.${accountId}.${tierId}`;
          const g = await commercial.grant({ accountId, amount: coinsReward.count, reason: 'recharge_milestone_claim', orderId });
          if (g.ok) finalSave = await mirrorCoins(cols, accountId, g.coinsAfter, now());
        } catch (e) {
          req.log.warn({ err: e }, 'recharge milestone claim coin grant failed (coins may be delayed)');
        }
      }
      return ok({ save: finalSave, rewards });
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
      const beforeCardDefIds = Object.values(before.cardInv).map((c) => c.defId);
      const marked = markDuplicates(before.inventory.skins, beforeCardDefIds, r.results).marked;
      // starter_draw delivers pack items (loot-box routing); starter_growth grants coins/subscription only (no items).
      if (r.results.length > 0) {
        await deliverOrder(
          cols, commercial, this.deps.socialsvc ?? nullMetaSocialsvcClient, accountId,
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
