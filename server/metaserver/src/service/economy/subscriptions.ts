// Monthly/year subscription cards (GACHA_DESIGN §5) + cumulative-recharge milestones (GACHA_DESIGN
// §13, ADR-045). Split out of service/economy.ts (2026-08-10, 独立函数模块 form — see economy.ts's
// facade comment). `claimRechargeMilestoneHandler` takes an explicit `ctx` (deps + `ensureCommercial`/
// `mutateSave`, bound by EconomyMixin's class body from its protected base methods); the other three
// handlers only need `ensureCommercial` + `deps`. `reconcileRechargeCoins` (a private method on the
// original mixin) only ever touched `this.deps`, so it became a plain deps-parameterized function with
// no ctx needed at all. No behavior change.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ErrorCode, err, ok, createLogger, claimRechargeReward, findRechargeTier, makeFreshRechargeMilestone,
  type RechargeReward, type SaveData,
} from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import { mirrorCoins, mirrorWalletFrom, adsDayKey } from '../../economy.js';
import { recordMaterialGrants } from '../../material.js';
import { accountIdOf, clientPlatformOf, type ServiceDeps } from '../base.js';

const log = createLogger('meta:economy');

type MutateSaveFn = (
  accountId: string,
  transform: (s: SaveData) => SaveData | string,
) => Promise<{ save: SaveData } | { error: string }>;

export interface SubscriptionsCtx {
  deps: ServiceDeps;
  ensureCommercial: (reply: FastifyReply) => boolean;
}

export interface RechargeMilestoneCtx {
  deps: ServiceDeps;
  ensureCommercial: (reply: FastifyReply) => boolean;
  mutateSave: MutateSaveFn;
}

/** Map a commercial subscription-card error to a client error code (single-slot gate surfaces ALREADY_ACTIVE; else BAD_REQUEST). */
function subscriptionErrCode(error: string): ErrorCode {
  return error === 'ALREADY_ACTIVE' ? ErrorCode.ALREADY_ACTIVE : ErrorCode.BAD_REQUEST;
}

/**
 * Buy the monthly card (GACHA_DESIGN §5). Single-slot: ALREADY_ACTIVE while a card is still running.
 * Native/WeChat clients must supply the store receipt for real verification (previously this endpoint
 * granted on a bare authenticated request — "treated as authorized" — with zero proof of payment; that
 * gap is closed here). Web (Paddle) never calls this REST route directly: the Paddle webhook calls
 * `commercial.monthlyCardBuy` in-process after its own signature check (see paddle.ts), so it is
 * unaffected by this gate.
 */
export async function monthlyCardBuyHandler(ctx: SubscriptionsCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!ctx.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { platform, receipt } = (req.body ?? {}) as { platform?: string; receipt?: string };
  if (!platform || !receipt) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing platform/receipt'));
  }
  const { cols, commercial, now } = ctx.deps;
  const receiptId = `${platform}:${receipt}`;
  const v = await commercial.verifyNonCoinReceipt({
    accountId, platform, receipt, receiptId, expectedProduct: 'monthly_card',
  });
  if (!v.ok) return reply.code(400).send(err(ErrorCode.INVALID_RECEIPT, 'receipt rejected'));
  const orderId = randomUUID();
  const clientPlatform = clientPlatformOf(req);
  const r = await commercial.monthlyCardBuy({ accountId, orderId, rechargePlatform: platform, clientPlatform });
  if (!r.ok) return reply.code(400).send(err(subscriptionErrCode(r.error), r.error));
  // r.wallet (comm-audit batch F item 3) saves the extra getWallet round trip when the caller populates it;
  // fall back to a fresh fetch for any CommercialClient implementation that doesn't yet (test doubles).
  const w = r.wallet ?? (await commercial.getWallet(accountId, clientPlatform));
  const save = w
    ? await mirrorWalletFrom(cols, accountId, w, now())
    : await getOrCreateSave(cols, accountId, now());
  return ok({ save });
}

/**
 * Buy the year card (GACHA_DESIGN §5): 365-day subscription, same single-slot gate + daily claim as
 * the monthly card. Same receipt-verification gate as monthlyCardBuy — see its doc comment.
 */
export async function yearCardBuyHandler(ctx: SubscriptionsCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!ctx.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { platform, receipt } = (req.body ?? {}) as { platform?: string; receipt?: string };
  if (!platform || !receipt) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing platform/receipt'));
  }
  const { cols, commercial, now } = ctx.deps;
  const receiptId = `${platform}:${receipt}`;
  const v = await commercial.verifyNonCoinReceipt({
    accountId, platform, receipt, receiptId, expectedProduct: 'year_card',
  });
  if (!v.ok) return reply.code(400).send(err(ErrorCode.INVALID_RECEIPT, 'receipt rejected'));
  const orderId = randomUUID();
  const clientPlatform = clientPlatformOf(req);
  const r = await commercial.yearCardBuy({ accountId, orderId, rechargePlatform: platform, clientPlatform });
  if (!r.ok) return reply.code(400).send(err(subscriptionErrCode(r.error), r.error));
  const w = r.wallet ?? (await commercial.getWallet(accountId, clientPlatform));
  const save = w
    ? await mirrorWalletFrom(cols, accountId, w, now())
    : await getOrCreateSave(cols, accountId, now());
  return ok({ save });
}

/** Claim the monthly card's daily coins (GACHA_DESIGN §5): once per UTC day while the subscription is active. */
export async function monthlyCardClaimHandler(ctx: SubscriptionsCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!ctx.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { cols, commercial, now } = ctx.deps;
  const dayKey = adsDayKey(now());
  const clientPlatform = clientPlatformOf(req);
  const r = await commercial.monthlyCardClaim({ accountId, dayKey, clientPlatform });
  if (!r.ok) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, r.error));
  const w = r.wallet ?? (await commercial.getWallet(accountId, clientPlatform));
  const save = w
    ? await mirrorWalletFrom(cols, accountId, w, now())
    : await getOrCreateSave(cols, accountId, now());
  return ok({ save, claimed: r.claimed });
}

/**
 * Grants the coin portion of a recharge tier's reward (idempotent: deterministic orderId, safe to
 * call whether or not a previous attempt already delivered it). Returns the current save on failure
 * (grant not (re)delivered — caller may be retried again later by a subsequent claim attempt).
 */
async function reconcileRechargeCoins(
  deps: ServiceDeps,
  accountId: string,
  tierId: number,
  clientPlatform: string | undefined,
  currentSave?: SaveData,
): Promise<SaveData> {
  const { cols, commercial, now } = deps;
  const def = findRechargeTier(tierId);
  const coinsReward = def?.rewards.find((r) => r.kind === 'coins');
  if (coinsReward && coinsReward.count > 0 && commercial.available) {
    try {
      const orderId = `recharge.claim.${accountId}.${tierId}`;
      const g = await commercial.grant({ accountId, amount: coinsReward.count, reason: 'recharge_milestone_claim', orderId, clientPlatform });
      if (g.ok) return mirrorCoins(cols, accountId, g.coinsAfter, now());
    } catch (e) {
      log.warn('recharge milestone coin grant failed (coins may be delayed)', { accountId, tierId, err: (e as Error).message });
    }
  }
  return currentSave ?? (await getOrCreateSave(cols, accountId, now()));
}

/**
 * Claim a cumulative-recharge milestone reward (GACHA_DESIGN §13, ADR-045). Progress (totalRechargeCents)
 * is commercial-authoritative and read live from the wallet; claim state lives in save.rechargeMilestone
 * (same split as battle pass's xp(commercial n/a, SaveData-native)/claimedFree(SaveData) — here the
 * progress source is commercial instead). Atomic validate + record claim (optimistic lock prevents
 * double-tap); material rewards are written to save.materials in the same transaction, coins are
 * delivered via commercial.grant afterward (mirrors claimBattlePass).
 *
 * Coin-grant reconciliation (2026-08-03 fix): the tier is marked claimed (irreversibly — a repeat
 * claim used to just bounce off ALREADY_CLAIMED) *before* the coin grant below runs; if that grant
 * throws or returns ok:false, the coins used to be silently lost with no way to retry (the mutateSave
 * had already committed). Since RECHARGE_TIERS is a static reward table and the grant's orderId is
 * deterministic (`recharge.claim.${accountId}.${tierId}`, safe to repeat via commercial's own
 * idempotency), an ALREADY_CLAIMED response can still recompute the tier's coin reward and retry the
 * grant here — a no-op if it already succeeded, an actual delivery if it didn't.
 */
export async function claimRechargeMilestoneHandler(ctx: RechargeMilestoneCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!ctx.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { tierId } = req.body as { tierId: number };
  const { commercial } = ctx.deps;
  const clientPlatform = clientPlatformOf(req);

  const wallet = await commercial.getWallet(accountId, clientPlatform);
  if (!wallet) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'wallet unavailable'));

  let claimedRewards: RechargeReward[] | null = null;
  const out = await ctx.mutateSave(accountId, (s) => {
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
        // Best-effort: retry the coin grant for this tier in case a prior claim committed the
        // milestone but never actually delivered the coins (see docstring above). Deterministic
        // orderId makes this safe to repeat even if it already succeeded.
        await reconcileRechargeCoins(ctx.deps, accountId, tierId, clientPlatform);
        return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'already claimed'));
      default:
        return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
    }
  }
  const rewards = claimedRewards!;
  // Material provenance (ITEM_IDENTITY_DESIGN.md task2, 2026-08-10): best-effort, after the mutateSave
  // above has already durably committed the counter increment(s). Each recharge tier is claimable at
  // most once per account ever (unlike battle pass, milestones don't reset per season), so
  // (accountId, tierId) alone is a safe natural idempotency key.
  const materialGrants: Record<string, number> = {};
  for (const reward of rewards) {
    if (reward.kind === 'material' && reward.id && reward.count > 0) {
      materialGrants[reward.id] = (materialGrants[reward.id] ?? 0) + reward.count;
    }
  }
  if (Object.keys(materialGrants).length > 0) {
    await recordMaterialGrants(
      ctx.deps.cols, accountId, `recharge_${accountId}_t${tierId}`, materialGrants, `recharge:${tierId}`, ctx.deps.now(),
    );
  }
  const finalSave = await reconcileRechargeCoins(ctx.deps, accountId, tierId, clientPlatform, out.save);
  return ok({ save: finalSave, rewards });
}
