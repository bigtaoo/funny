// Live-ops retention: check-in calendar + daily tasks (B5) + weekly active chest. Split out of
// liveops.ts (2026-08-10, 独立函数模块 form — see liveops.ts's facade comment). The claim* handlers
// take an explicit `ctx` (deps + `mutateSave`, bound by LiveOpsMixin's class body from its protected
// base method) since they need the rev-guarded read-modify-write; the read-only/settle helpers only
// ever touched `this.deps`, so they take plain `deps`. No behavior change.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SaveData, CheckinReward, WeeklyChestReward } from '@nw/shared';
import {
  ErrorCode,
  err,
  ok,
  resetStaleRetention,
  claimCheckinDay,
  claimDailyReward as calcDailyReward,
  CHECKIN_REWARDS,
  DAILY_TASKS,
  DAILY_POINTS_THRESHOLD,
  DAILY_COINS_REWARD,
  WEEKLY_CHEST_TIERS,
  claimWeeklyTier,
  weeklyClaimableTiers,
  nextCheckinDay,
  dailyRewardClaimable,
  makeDayKey,
  makeMonthKey,
  makeWeekKey,
  pickRandomCatalogItem,
  CARD_DEFS,
  EQUIPMENT_DEFS,
  rollCraftedAffixes,
  ADS_REWARD_COINS,
  ADS_DAILY_CAP,
  ADS_MIN_INTERVAL_MS,
} from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import { mirrorCoins, adsDayKey, peekAdsStatus } from '../../economy.js';
import { accountIdOf, type ServiceDeps } from '../base.js';
import { deliverRetentionReward } from './helpers.js';

type MutateSaveFn = (
  accountId: string,
  transform: (s: SaveData) => SaveData | string,
) => Promise<{ save: SaveData } | { error: string }>;

export interface RetentionCtx {
  deps: ServiceDeps;
  mutateSave: MutateSaveFn;
  ensureCommercial: (reply: FastifyReply) => boolean;
}

/** Read current retention state (including definition tables; used by the client to render the calendar/task cards). */
export async function getRetentionHandler(deps: ServiceDeps, req: FastifyRequest) {
  const accountId = accountIdOf(req);
  const { cols, now, redis } = deps;
  const tsMs = now();
  const save = await getOrCreateSave(cols, accountId, tsMs);
  const retention = resetStaleRetention(save.retention, tsMs);
  const adsStatus = await peekAdsStatus(redis, accountId, adsDayKey(tsMs), ADS_MIN_INTERVAL_MS, tsMs);
  return ok({
    checkin: retention.checkin ?? null,
    daily: retention.daily ?? null,
    weekly: retention.weekly ?? null,
    defs: {
      rewards: CHECKIN_REWARDS,
      tasks: DAILY_TASKS,
      pointsThreshold: DAILY_POINTS_THRESHOLD,
      dailyCoinsReward: DAILY_COINS_REWARD,
      weeklyChestTiers: WEEKLY_CHEST_TIERS,
    },
    claimable: {
      checkin: nextCheckinDay(retention, tsMs) !== null,
      daily: dailyRewardClaimable(retention, tsMs),
      weeklyTiers: weeklyClaimableTiers(retention, tsMs),
    },
    ads: {
      watchedToday: adsStatus.watchedToday,
      cap: ADS_DAILY_CAP,
      rewardCoins: ADS_REWARD_COINS,
      cooldownMs: ADS_MIN_INTERVAL_MS,
      nextAvailableAt: adsStatus.nextAvailableAt,
    },
  });
}

/**
 * Deliver a claimed check-in reward's follow-up (coins/card/equipment + the milestone bonusCoins
 * top-up; material/stamina are applied synchronously inside claimCheckin's mutateSave and never
 * reach here). Called both right after a fresh claim and from claimCheckin's ALREADY_CLAIMED_TODAY
 * recovery branch (a retry of a request whose delivery step failed after the day was already
 * durably marked claimed) — every sub-delivery below is idempotent by a deterministic orderId, so
 * calling this twice for the same (accountId, day) is always safe and simply replays whatever
 * already landed.
 */
async function settleCheckinReward(
  deps: ServiceDeps,
  accountId: string,
  day: number,
  reward: CheckinReward,
  tsMs: number,
): Promise<{ save: SaveData; reward: CheckinReward } | { error: string; code: string }> {
  const { cols, commercial, now } = deps;
  const monthKey = makeMonthKey(tsMs);
  let deliveredId: string | undefined;

  if (reward.kind === 'coins' && commercial.available) {
    const orderId = `checkin:${accountId}:${monthKey}:${day}`;
    const g = await commercial.grant({ accountId, amount: reward.count, reason: 'checkin', orderId });
    if (!g.ok) return { error: 'coins grant failed, retry', code: 'REV_CONFLICT' };
    await mirrorCoins(cols, accountId, g.coinsAfter, tsMs); // writes save.wallet.coins; final value re-read below via getOrCreateSave
  } else if (reward.kind === 'card') {
    const orderId = `checkin_item:${accountId}:${monthKey}:${day}`;
    const r = await deliverRetentionReward(deps, accountId, orderId, 'checkin_reward', () => {
      const picked = pickRandomCatalogItem('card');
      // Fallback only reachable if the whole card catalogue were empty (would break far more than
      // this one delivery) — non-null assertion documents that assumption rather than silently
      // dropping the reward the way the pre-fix code did when `def` came back undefined.
      const def = (picked && CARD_DEFS[picked.itemId]) || Object.values(CARD_DEFS)[0]!;
      const instanceId = `card_checkin_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      return {
        kind: 'card', defId: def.id,
        instance: { id: instanceId, defId: def.id, level: 1, gear: {}, locked: false, sourceType: `checkin:${monthKey}`, obtainedAt: now() },
      };
    });
    if ('error' in r) return r;
    deliveredId = r.deliveredId;
  } else if (reward.kind === 'equipment') {
    const orderId = `checkin_item:${accountId}:${monthKey}:${day}`;
    const r = await deliverRetentionReward(deps, accountId, orderId, 'checkin_reward', () => {
      const picked = pickRandomCatalogItem('equip_t1');
      const def = (picked && EQUIPMENT_DEFS[picked.itemId]) || Object.values(EQUIPMENT_DEFS)[0]!; // see the card branch above for the fallback rationale
      const instanceId = `eq_checkin_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      return {
        kind: 'equipment', defId: def.defId,
        instance: { id: instanceId, defId: def.defId, rarity: def.rarity, level: 0, affixes: rollCraftedAffixes(def.defId, instanceId), sourceType: `checkin:${monthKey}`, obtainedAt: now() },
      };
    });
    if ('error' in r) return r;
    deliveredId = r.deliveredId;
  }
  if (reward.bonusCoins && commercial.available) {
    const orderId = `checkin:bonus:${accountId}:${monthKey}:${day}`;
    const g = await commercial.grant({ accountId, amount: reward.bonusCoins, reason: 'checkin_bonus', orderId });
    if (!g.ok) return { error: 'bonus coins grant failed, retry', code: 'REV_CONFLICT' };
    await mirrorCoins(cols, accountId, g.coinsAfter, tsMs);
  }
  const save = await getOrCreateSave(cols, accountId, now());
  const finalReward = deliveredId ? { ...reward, id: deliveredId } : reward;
  return { save, reward: finalReward };
}

/** Claim the next check-in reward for this month (idempotent: already claimed today → 409). */
export async function claimCheckinHandler(ctx: RetentionCtx, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { now } = ctx.deps;
  const tsMs = now();

  let reward: CheckinReward | null = null;
  let claimedDay = 0;
  const recorded = await ctx.mutateSave(accountId, (s) => {
    const r = resetStaleRetention(s.retention, tsMs);
    const result = claimCheckinDay(r, tsMs);
    if (!result.ok) return result.error;
    reward = result.reward;
    claimedDay = result.day;
    const newRetention = { ...r, checkin: result.newCheckin };
    let next = { ...s, retention: newRetention };
    // Check-in reward: stamina/material types are written directly to save.materials;
    // coins/card/equipment types need a follow-up call (commercial grant / roster+inventory
    // write) and are delivered below, once the claim itself is durably recorded.
    if (result.reward.kind === 'stamina') {
      next = {
        ...next,
        materials: { ...next.materials, stamina: (next.materials['stamina'] ?? 0) + result.reward.count },
      };
    } else if (result.reward.kind === 'material' && result.reward.id) {
      const matId = result.reward.id;
      next = {
        ...next,
        materials: { ...next.materials, [matId]: (next.materials[matId] ?? 0) + result.reward.count },
        everOwned: { ...next.everOwned, material: [...new Set([...(next.everOwned?.material ?? []), matId])] },
      };
    }
    return next;
  });
  if ('error' in recorded) {
    if (recorded.error === 'ALREADY_CLAIMED_TODAY' || recorded.error === 'MONTH_FULL') {
      // 2026-08-05 resilience fix: the day was already durably marked claimed — possibly by
      // THIS same client's earlier request whose delivery step then failed (see
      // deliverRetentionReward's doc comment for the full root cause). Recover instead of
      // bouncing a bare 409: look up which day/reward was actually claimed and resume its
      // delivery. settleCheckinReward is idempotent by deterministic orderId, so this is exactly
      // as safe whether the earlier delivery fully succeeded (pure replay), partially succeeded
      // (resumes the missing piece), or never started (delivers fresh) — the only case that
      // still legitimately means "no, you already got this and there's nothing to resume" is
      // material/stamina rewards, which settleCheckinReward has nothing to do for either.
      //
      // Both error tags land here because claimCheckinDay checks nextSlot > CHECKIN_TOTAL_DAYS
      // BEFORE lastClaimedDayKey === dayKey — so a retry on day 30 specifically (the month's last
      // slot: claimedDays.length is already 30, so nextSlot=31 trips MONTH_FULL first) reports
      // MONTH_FULL for what is really "already claimed *today*", the exact same recoverable case
      // as every other day reports via ALREADY_CLAIMED_TODAY. Disambiguate from a genuine
      // month-exhausted-on-a-different-day 409 via lastClaimedDayKey rather than trusting the tag.
      const dayKey = makeDayKey(tsMs);
      const peekSave = await getOrCreateSave(ctx.deps.cols, accountId, tsMs);
      const checkin = resetStaleRetention(peekSave.retention, tsMs).checkin;
      const lastDay = checkin?.lastClaimedDayKey === dayKey ? checkin.claimedDays.at(-1) : undefined;
      const lastReward = lastDay ? CHECKIN_REWARDS[lastDay - 1] : undefined;
      if (lastDay && lastReward && (lastReward.kind === 'card' || lastReward.kind === 'equipment' || lastReward.kind === 'coins' || lastReward.bonusCoins)) {
        const settled = await settleCheckinReward(ctx.deps, accountId, lastDay, lastReward, tsMs);
        if ('error' in settled) return reply.code(502).send(err(ErrorCode.REV_CONFLICT, settled.error));
        return ok({ save: settled.save, day: lastDay, reward: settled.reward });
      }
      const msg = recorded.error === 'MONTH_FULL' ? 'month fully claimed' : 'already claimed today';
      return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, msg));
    }
    return reply.code(409).send(err(ErrorCode.REV_CONFLICT, recorded.error));
  }
  // `reward` was assigned inside the mutateSave closure above, so TS no longer narrows its type
  // past that point (widens to the declared `CheckinReward | null`); copy to a fresh binding so
  // the rest of the function gets ordinary control-flow narrowing.
  const claimedReward = reward as CheckinReward | null;
  if (!claimedReward) return ok({ save: recorded.save, day: claimedDay, reward: claimedReward });
  const settled = await settleCheckinReward(ctx.deps, accountId, claimedDay, claimedReward, tsMs);
  if ('error' in settled) {
    // Claim is durably recorded; delivery failed but is retryable (deterministic orderId) via the
    // ALREADY_CLAIMED_TODAY recovery branch above the next time this account calls /retention/checkin.
    return reply.code(502).send(err(ErrorCode.REV_CONFLICT, settled.error));
  }
  return ok({ save: settled.save, day: claimedDay, reward: settled.reward });
}

/** Claim daily task completion coins (idempotent: threshold not reached → 400, already claimed → 409). */
export async function claimDailyRewardHandler(ctx: RetentionCtx, req: FastifyRequest, reply: FastifyReply) {
  if (!ctx.ensureCommercial(reply)) return;
  const accountId = accountIdOf(req);
  const { commercial, cols, now } = ctx.deps;
  const tsMs = now();

  const recorded = await ctx.mutateSave(accountId, (s) => {
    const r = resetStaleRetention(s.retention, tsMs);
    const result = calcDailyReward(r, tsMs);
    if (!result.ok) return result.error;
    const daily = r.daily!;
    const newRetention = { ...r, daily: { ...daily, rewardClaimed: true } };
    return { ...s, retention: newRetention };
  });
  if ('error' in recorded) {
    if (recorded.error === 'NOT_REACHED') {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'task points not reached'));
    }
    if (recorded.error === 'ALREADY_CLAIMED') {
      // 2026-08-05 resilience fix: `rewardClaimed` is set durably BEFORE the coin grant below runs,
      // so a request whose grant call failed leaves this flag true forever with the coins never
      // delivered — a client retry used to just bounce off this branch with a bare 409, permanently
      // losing the reward. commercial.grant is idempotent by orderId (insertOne on a unique `orders`
      // doc, see commercial/src/service/shop.ts), and `daily:${accountId}:${dayKey}` is deterministic
      // from state alone — so it's always safe to simply retry the SAME grant call here instead of
      // just rejecting: a fully-delivered prior attempt replays its stored coinsAfter (no double
      // credit), a failed one finally completes.
      const orderId = `daily:${accountId}:${makeDayKey(tsMs)}`;
      const g = await commercial.grant({ accountId, amount: DAILY_COINS_REWARD, reason: 'daily_task', orderId });
      if (!g.ok) return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'daily reward already claimed'));
      const save = await mirrorCoins(cols, accountId, g.coinsAfter, tsMs);
      return ok({ save, coins: DAILY_COINS_REWARD });
    }
    if (recorded.error === 'WRONG_DAY') {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'no daily tasks completed today'));
    }
    return reply.code(409).send(err(ErrorCode.REV_CONFLICT, recorded.error));
  }
  const orderId = `daily:${accountId}:${makeDayKey(tsMs)}`;
  const g = await commercial.grant({ accountId, amount: DAILY_COINS_REWARD, reason: 'daily_task', orderId });
  // Claim is durably recorded regardless of what happens below (see the ALREADY_CLAIMED branch
  // above for the retry path — same deterministic orderId makes a later retry always safe).
  if (!g.ok) return reply.code(502).send(err(ErrorCode.BAD_REQUEST, 'coin grant failed, retry'));
  const save = await mirrorCoins(cols, accountId, g.coinsAfter, tsMs);
  return ok({ save, coins: DAILY_COINS_REWARD });
}

/**
 * Deliver a claimed weekly-chest tier's equipment/skin follow-up (material rewards are applied
 * synchronously inside claimWeeklyChest's mutateSave and never reach here). Same idempotent-by-
 * deterministic-orderId shape as settleCheckinReward — safe to call twice for the same
 * (accountId, weekKey, threshold), whether from a fresh claim or from claimWeeklyChest's
 * ALREADY_CLAIMED recovery branch.
 */
async function settleWeeklyChestReward(
  deps: ServiceDeps,
  accountId: string,
  threshold: number,
  reward: WeeklyChestReward,
  tsMs: number,
): Promise<{ save: SaveData; reward: WeeklyChestReward } | { error: string; code: string }> {
  const { cols, now } = deps;
  const weekKey = makeWeekKey(tsMs);
  let deliveredId: string | undefined;

  if (reward.kind === 'equipment') {
    const orderId = `weekly_chest_item:${accountId}:${weekKey}:${threshold}`;
    const r = await deliverRetentionReward(deps, accountId, orderId, 'weekly_chest', () => {
      const picked = pickRandomCatalogItem('equip_t1');
      const def = (picked && EQUIPMENT_DEFS[picked.itemId]) || Object.values(EQUIPMENT_DEFS)[0]!; // see settleCheckinReward's card branch for the fallback rationale
      const instanceId = `eq_weekly_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      return {
        kind: 'equipment', defId: def.defId,
        instance: { id: instanceId, defId: def.defId, rarity: def.rarity, level: 0, affixes: rollCraftedAffixes(def.defId, instanceId), sourceType: `weekly_chest:${weekKey}`, obtainedAt: now() },
      };
    });
    if ('error' in r) return r;
    deliveredId = r.deliveredId;
  } else if (reward.kind === 'card') {
    // Random legendary (Anna-faction, "orange") card — see retention.ts WEEKLY_CHEST_TIERS
    // comment (2026-08-08) for why this replaced the original whole-shop-skin substitution.
    // Mirrors settleCheckinReward's 'card' branch, narrowed to rarity: 'legendary' instead of
    // drawing from the whole (epic + legendary) card catalogue.
    const orderId = `weekly_chest_item:${accountId}:${weekKey}:${threshold}`;
    const r = await deliverRetentionReward(deps, accountId, orderId, 'weekly_chest', () => {
      const picked = pickRandomCatalogItem('card', undefined, 'legendary');
      const def = (picked && CARD_DEFS[picked.itemId]) || Object.values(CARD_DEFS).find((c) => c.faction === 'anna')!; // see settleCheckinReward's card branch for the fallback rationale
      const instanceId = `card_weekly_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      return {
        kind: 'card', defId: def.id,
        instance: { id: instanceId, defId: def.id, level: 1, gear: {}, locked: false, sourceType: `weekly_chest:${weekKey}`, obtainedAt: now() },
      };
    });
    if ('error' in r) return r;
    deliveredId = r.deliveredId;
  }
  const save = await getOrCreateSave(cols, accountId, now());
  const finalReward = deliveredId ? { ...reward, id: deliveredId } : reward;
  return { save, reward: finalReward };
}

/**
 * Claim one weekly active chest tier (ECONOMY_NUMBERS §12.3). Mirrors claimCheckin's shape:
 * record the claim (idempotent, `claimedTiers.includes` guard inside claimWeeklyTier) →
 * material rewards are written synchronously in the same mutateSave; equipment/card rewards
 * resolve their concrete item at claim time (uniform random draw, like checkin's 'card'/
 * 'equipment' milestones) and deliver via a follow-up call once the claim itself is durable.
 */
export async function claimWeeklyChestHandler(ctx: RetentionCtx, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { now } = ctx.deps;
  const tsMs = now();
  const { threshold } = req.body as { threshold: number };

  let reward: WeeklyChestReward | null = null;
  const recorded = await ctx.mutateSave(accountId, (s) => {
    const r = resetStaleRetention(s.retention, tsMs);
    const result = claimWeeklyTier(r, threshold, tsMs);
    if (!result.ok) return result.error;
    reward = result.reward;
    const newRetention = { ...r, weekly: result.newWeekly };
    let next = { ...s, retention: newRetention };
    if (result.reward.kind === 'material' && result.reward.id) {
      const matId = result.reward.id;
      next = {
        ...next,
        materials: { ...next.materials, [matId]: (next.materials[matId] ?? 0) + result.reward.count },
        everOwned: { ...next.everOwned, material: [...new Set([...(next.everOwned?.material ?? []), matId])] },
      };
    }
    return next;
  });
  if ('error' in recorded) {
    if (recorded.error === 'ALREADY_CLAIMED') {
      // 2026-08-05 resilience fix: mirrors claimCheckin's ALREADY_CLAIMED_TODAY recovery branch
      // (see deliverRetentionReward's doc comment for the root cause) — the tier was already
      // durably marked claimed, possibly by an earlier request whose equipment/card delivery then
      // failed. WEEKLY_CHEST_TIERS' reward kind is static per threshold (not derived from
      // transactional state), so it can be looked up directly without re-running claimWeeklyTier.
      const tierDef = WEEKLY_CHEST_TIERS.find((t) => t.threshold === threshold);
      if (tierDef && (tierDef.reward.kind === 'equipment' || tierDef.reward.kind === 'card')) {
        const settled = await settleWeeklyChestReward(ctx.deps, accountId, threshold, tierDef.reward, tsMs);
        if ('error' in settled) return reply.code(502).send(err(ErrorCode.REV_CONFLICT, settled.error));
        return ok({ save: settled.save, threshold, reward: settled.reward });
      }
      return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'tier already claimed'));
    }
    if (recorded.error === 'NOT_REACHED') {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'weekly points threshold not reached'));
    }
    if (recorded.error === 'BAD_REQUEST') {
      return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown chest tier'));
    }
    return reply.code(409).send(err(ErrorCode.REV_CONFLICT, recorded.error));
  }
  const claimedReward = reward as WeeklyChestReward | null;
  if (!claimedReward) return ok({ save: recorded.save, threshold, reward: claimedReward });
  const settled = await settleWeeklyChestReward(ctx.deps, accountId, threshold, claimedReward, tsMs);
  if ('error' in settled) {
    // Claim is durably recorded; delivery failed but is retryable via the ALREADY_CLAIMED
    // recovery branch above the next time this account calls /retention/weekly-chest.
    return reply.code(502).send(err(ErrorCode.REV_CONFLICT, settled.error));
  }
  return ok({ save: settled.save, threshold, reward: settled.reward });
}
