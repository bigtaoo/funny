// Rewarded ads, IAP receipt verification, promo codes (C2/B-PROMO). Split out of service/economy.ts
// (2026-08-10, 独立函数模块 form — see economy.ts's facade comment). All three handlers only need
// `ensureCommercial` + `deps`, bound by EconomyMixin's class body from its protected base method. No
// behavior change.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok, ADS_REWARD_COINS, ADS_DAILY_CAP, ADS_MIN_INTERVAL_MS } from '@nw/shared';
import { accrueEventTask } from '../../events.js';
import { verifyAdPlatformToken } from '../../ads.js';
import { adsDayKey, bumpAdsCap, hashAdToken, recordAdToken, checkAdInterval, mirrorCoins } from '../../economy.js';
import { accountIdOf, clientPlatformOf, type ServiceDeps } from '../base.js';

export interface AdsPromoCtx {
  deps: ServiceDeps;
  ensureCommercial: (reply: FastifyReply) => boolean;
}

export async function adsRewardHandler(ctx: AdsPromoCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!ctx.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { adToken, platform } = req.body as { adToken: string; platform?: string };
  if (!adToken) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing adToken'));

  const { cols, commercial, now, redis } = ctx.deps;
  const ts = now();
  const dayKey = adsDayKey(ts);

  // 30-minute interval gate (C2).
  const intervalOk = await checkAdInterval(redis, accountId, dayKey, ts, ADS_MIN_INTERVAL_MS);
  if (!intervalOk) {
    return reply.code(429).send(err(ErrorCode.DAILY_CAP_REACHED, 'ad cooldown not elapsed'));
  }

  // Daily cap (C2).
  const allowed = await bumpAdsCap(redis, accountId, dayKey, ADS_DAILY_CAP);
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

  const credit = await commercial.adsCredit({ accountId, amount: ADS_REWARD_COINS, dayKey, clientPlatform: clientPlatformOf(req) });
  if (!credit.ok) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, credit.error));
  const save = await mirrorCoins(cols, accountId, credit.coinsAfter, now());
  // B6: record event task "ad.watch" (best-effort).
  accrueEventTask(cols, accountId, 'ad.watch', now()).catch(() => {});
  return ok({ save, granted: ADS_REWARD_COINS });
}

export async function iapVerifyHandler(ctx: AdsPromoCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!ctx.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { platform, receipt } = req.body as { platform: string; receipt: string };
  if (!platform || !receipt) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing platform/receipt'));
  }
  const { cols, commercial, now } = ctx.deps;
  // receiptId = unique platform receipt id (idempotency key). The dev stub uses platform:receipt; real channel integration uses the platform transaction id.
  const receiptId = `${platform}:${receipt}`;
  const v = await commercial.rechargeVerify({ accountId, platform, receipt, receiptId, clientPlatform: clientPlatformOf(req) });
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
export async function redeemPromoCodeHandler(ctx: AdsPromoCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!ctx.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { code } = req.body as { code: string };
  if (!code || typeof code !== 'string') {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'code required'));
  }
  const { cols, commercial, now } = ctx.deps;
  const v = await commercial.promoRedeem({ accountId, code, clientPlatform: clientPlatformOf(req) });
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
