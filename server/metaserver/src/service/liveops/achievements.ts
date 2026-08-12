// Live-ops achievements (S9). Split out of liveops.ts (2026-08-10, 独立函数模块 form — see liveops.ts's
// facade comment). `claimAchievementHandler` takes `core: MetaCore` directly (2026-08-11 ctx-bind
// cleanup — see base.ts's header: no more ctx object / bound methods, just `core.mutateSave(...)` /
// `core.ensureCommercial(...)` as ordinary method calls). No behavior change.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok, ACHIEVEMENTS, findAchievement, validateClaim } from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import { mirrorCoins } from '../../economy.js';
import { grantTitleToPlayer } from '../../titles.js';
import { accountIdOf, type ServiceDeps, type MetaCore } from '../base.js';

/** Achievement definition table + my stats + claimed progress (tier computation is done client-side, §4.1/§6). */
export async function getAchievementsHandler(deps: ServiceDeps, req: FastifyRequest) {
  const accountId = accountIdOf(req);
  const save = await getOrCreateSave(deps.cols, accountId, deps.now());
  return ok({
    defs: ACHIEVEMENTS,
    stats: save.stats ?? {},
    achievements: save.achievements ?? {},
  });
}

/**
 * Claim coins for a specific achievement tier (§4.3): server re-validates stat ≥ threshold + not yet claimed → atomically record claimedTiers (idempotency guard)
 * → commercial grants coins (deterministic orderId prevents double delivery) → mirror wallet back.
 * Record the tier first (sole winner) then deliver coins: concurrent double-taps result in only one recording and one delivery, the other sees "already claimed" and is rejected;
 * crash window (recorded but not delivered) can be compensated later via deterministic orderId — acceptable given the small one-time amount.
 */
export async function claimAchievementHandler(core: MetaCore, req: FastifyRequest, reply: FastifyReply) {
  if (!core.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { achId, tier } = req.body as { achId: string; tier: number };
  if (!findAchievement(achId)) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown achievement'));
  }

  // Atomically record the tier: equivalent to validate + $addToSet (already-claimed/not-reached checked inside transform). Success = this call is the sole winner.
  const recorded = await core.mutateSave(accountId, (s) => {
    const claimed = s.achievements?.[achId]?.claimedTiers ?? [];
    const v = validateClaim(achId, tier, s.stats, claimed);
    if (!v.ok) return v.error; // NOT_REACHED / ALREADY_CLAIMED / BAD_REQUEST
    return {
      ...s,
      achievements: {
        ...s.achievements,
        [achId]: { claimedTiers: [...claimed, tier] },
      },
    };
  });
  if ('error' in recorded) {
    if (recorded.error === 'NOT_REACHED') {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'threshold not reached'));
    }
    if (recorded.error === 'ALREADY_CLAIMED') {
      return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'tier already claimed'));
    }
    if (recorded.error === 'BAD_REQUEST') {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid tier'));
    }
    return reply.code(409).send(err(ErrorCode.REV_CONFLICT, recorded.error));
  }

  // Tier recorded → deliver coins (deterministic orderId, idempotent) + mirror wallet. Amount taken from the definition (the already-validated tier).
  const def = findAchievement(achId)!;
  const coins = def.tiers[tier - 1]?.coins ?? 0;
  const { cols, commercial, now } = core.deps;
  const orderId = `ach:${accountId}:${achId}:${tier}`;
  const g = await commercial.grant({ accountId, amount: coins, reason: 'achievement', orderId });
  if (!g.ok) {
    // Tier recorded but coin delivery failed: return current save (tier is claimed), granted=0; deterministic orderId allows later compensation.
    return ok({ save: recorded.save, granted: 0 });
  }
  const save = await mirrorCoins(cols, accountId, g.coinsAfter, now());

  // Final tier reached and the achievement has an associated title → grant it (idempotent, best-effort)
  if (tier === def.tiers.length && def.titleId) {
    await grantTitleToPlayer(cols, accountId, def.titleId, now()).catch(() => {/* ignore */});
  }

  return ok({ save, granted: coins });
}
