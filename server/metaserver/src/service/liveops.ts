// Live-ops progression: achievements (S9), retention check-in / daily tasks (B5), limited-time events
// (B6), and player titles (S10). Counts are written only at authoritative settlement points elsewhere;
// these handlers read definitions/progress and deliver one-time coin/title claims.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  err,
  ok,
  ACHIEVEMENTS,
  findAchievement,
  validateClaim,
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
  pickWeeklyChestSkin,
  nextCheckinDay,
  dailyRewardClaimable,
  makeDayKey,
  makeMonthKey,
  makeWeekKey,
  parseTitleId,
  pickRandomCatalogItem,
  CARD_DEFS,
  EQUIPMENT_DEFS,
  rollCraftedAffixes,
  ADS_REWARD_COINS,
  ADS_DAILY_CAP,
  ADS_MIN_INTERVAL_MS,
  EQUIPMENT_IDEM_TTL_SEC,
  type EquipmentInstance,
  type CardInstance,
  type CheckinReward,
} from '@nw/shared';
import { getOrCreateSave, isAvatarOwned, isSkinOwned, PRESET_AVATAR_IDS } from '../save.js';
import { mirrorCoins, adsDayKey, peekAdsStatus } from '../economy.js';
import { grantTitleToPlayer } from '../titles.js';
import { getEventsForAccount, claimEventReward } from '../events.js';
import { nullMetaSocialsvcClient } from '../socialsvcClient.js';
import { grantCard } from '../cards.js';
import { grantEquipment } from '../equipment.js';
import { grantSkin } from '../skin.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, type Constructor, type MetaBaseCtor } from './base.js';
import type { SocialBadges } from '@nw/shared';

function idemExpireAt(nowMs: number): Date {
  return new Date(nowMs + EQUIPMENT_IDEM_TTL_SEC * 1000);
}

/** The concrete item resolved for a checkin/weekly-chest reward that needs an async delivery call
 *  (card/equipment/skin — material rewards are applied synchronously and never reach this). Picked
 *  ONCE and persisted to `cols.equipmentIdem` before the grant call runs (see deliverRetentionReward). */
type RetentionItemPick =
  | { kind: 'card'; instance: CardInstance; defId: string }
  | { kind: 'equipment'; instance: EquipmentInstance; defId: string }
  | { kind: 'skin'; skinId: string };

type LiveOpsHandlers = Pick<
  MetaHandlers,
  | 'getAchievements' | 'claimAchievement' | 'getRetention' | 'claimCheckin' | 'claimDailyReward'
  | 'claimWeeklyChest'
  | 'getEvents' | 'claimEventReward' | 'getTitles' | 'equipTitle' | 'equipAvatar' | 'equipSkin'
  | 'setFlag' | 'getLobbyBadges'
>;

/** Flag keys must be non-empty and reasonably short (dynamic namespace includes `featSeen.<featureId>`) — guards against a malformed client body writing garbage keys into the flags map. */
const MAX_FLAG_KEY_LEN = 100;

const ZERO_SOCIAL_BADGES: SocialBadges = { friendRequests: 0, chat: 0, mail: 0, total: 0 };

export function LiveOpsMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<LiveOpsHandlers> {
  return class extends Base {
    /** Achievement definition table + my stats + claimed progress (tier computation is done client-side, §4.1/§6). */
    async getAchievements(req: FastifyRequest) {
      const accountId = accountIdOf(req);
      const save = await getOrCreateSave(this.deps.cols, accountId, this.deps.now());
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
    async claimAchievement(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { achId, tier } = req.body as { achId: string; tier: number };
      if (!findAchievement(achId)) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown achievement'));
      }

      // Atomically record the tier: equivalent to validate + $addToSet (already-claimed/not-reached checked inside transform). Success = this call is the sole winner.
      const recorded = await this.mutateSave(accountId, (s) => {
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
      const { cols, commercial, now } = this.deps;
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

    /** Read current retention state (including definition tables; used by the client to render the calendar/task cards). */
    async getRetention(req: FastifyRequest) {
      const accountId = accountIdOf(req);
      const { cols, now, redis } = this.deps;
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
     * Deliver a checkin/weekly-chest reward that needs an async grant call (card/equipment/skin —
     * material/stamina/coins are handled by their own callers and never reach here) exactly once,
     * surviving a failed grant across retries.
     *
     * 2026-08-05 resilience fix. Root cause: claimCheckin/claimWeeklyChest mark the underlying claim
     * durably (mutateSave, "already claimed" guard) BEFORE this ever runs — that ordering is correct
     * and unchanged, it's the single race-free gate that lets concurrent duplicate requests serialize
     * to one winner. The bug was in what happened AFTER: the picked item's grant call
     * (grantEquipment/grantSkin/grantCard) could fail (rev conflict, transient DB blip) and the
     * failure was silently swallowed — the claim stayed marked forever, the item was never delivered,
     * and a client retry just got bounced with ALREADY_CLAIMED before ever reaching the grant again.
     *
     * Fix mirrors equipment.ts's craft/enhance/salvage `committed` idem-ledger convention (same
     * `cols.equipmentIdem` collection, new `checkin_reward`/`weekly_chest` ops): the concrete item is
     * picked and persisted with `committed: false` BEFORE the grant call runs, so re-entering this
     * method later (the caller re-enters it from the ALREADY_CLAIMED recovery branch) resumes
     * delivering the *same* item — picked once, never re-rolled — instead of losing it or granting a
     * second, different one. grantEquipment/grantSkin/grantCard are themselves idempotent by
     * instance.id/skinId, so replaying the grant call itself is always safe too.
     */
    private async deliverRetentionReward(
      accountId: string,
      orderId: string,
      op: 'checkin_reward' | 'weekly_chest',
      pick: () => RetentionItemPick,
    ): Promise<{ deliveredId: string } | { error: string; code: string }> {
      const { cols, now } = this.deps;
      let claim = await cols.equipmentIdem.findOne({ _id: orderId });
      if (!claim) {
        const picked = pick();
        try {
          await cols.equipmentIdem.insertOne({
            _id: orderId, accountId, op, result: picked, committed: false, expireAt: idemExpireAt(now()),
          });
          claim = { _id: orderId, accountId, op, result: picked, committed: false, expireAt: idemExpireAt(now()) };
        } catch (e) {
          if ((e as { code?: number }).code !== 11000) throw e;
          // Lost the insert race to a concurrent caller (e.g. two requests both hit ALREADY_CLAIMED and
          // recovered here at once) — read back whichever pick won; deliver that one, not ours.
          claim = await cols.equipmentIdem.findOne({ _id: orderId });
        }
      }
      if (!claim) return { error: 'reward grant failed, retry', code: 'REV_CONFLICT' };
      const picked = claim.result as RetentionItemPick;
      const deliveredId = picked.kind === 'skin' ? picked.skinId : picked.defId;
      if (claim.committed) return { deliveredId }; // already delivered by an earlier attempt — pure replay, no DB write

      const g = picked.kind === 'equipment' ? await grantEquipment(cols, now, accountId, picked.instance)
        : picked.kind === 'skin' ? await grantSkin(cols, now, accountId, picked.skinId)
        : await grantCard(cols, now, accountId, picked.instance);
      if ('error' in g) return { error: g.error, code: g.code };
      await cols.equipmentIdem.updateOne({ _id: orderId }, { $set: { committed: true } });
      return { deliveredId };
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
    private async settleCheckinReward(
      accountId: string,
      day: number,
      reward: CheckinReward,
      tsMs: number,
    ): Promise<{ save: import('@nw/shared').SaveData; reward: CheckinReward } | { error: string; code: string }> {
      const { cols, commercial, now } = this.deps;
      const monthKey = makeMonthKey(tsMs);
      let deliveredId: string | undefined;

      if (reward.kind === 'coins' && commercial.available) {
        const orderId = `checkin:${accountId}:${monthKey}:${day}`;
        const g = await commercial.grant({ accountId, amount: reward.count, reason: 'checkin', orderId });
        if (!g.ok) return { error: 'coins grant failed, retry', code: 'REV_CONFLICT' };
        await mirrorCoins(cols, accountId, g.coinsAfter, tsMs); // writes save.wallet.coins; final value re-read below via getOrCreateSave
      } else if (reward.kind === 'card') {
        const orderId = `checkin_item:${accountId}:${monthKey}:${day}`;
        const r = await this.deliverRetentionReward(accountId, orderId, 'checkin_reward', () => {
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
        const r = await this.deliverRetentionReward(accountId, orderId, 'checkin_reward', () => {
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
    async claimCheckin(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { now } = this.deps;
      const tsMs = now();

      let reward: import('@nw/shared').CheckinReward | null = null;
      let claimedDay = 0;
      const recorded = await this.mutateSave(accountId, (s) => {
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
          const peekSave = await getOrCreateSave(this.deps.cols, accountId, tsMs);
          const checkin = resetStaleRetention(peekSave.retention, tsMs).checkin;
          const lastDay = checkin?.lastClaimedDayKey === dayKey ? checkin.claimedDays.at(-1) : undefined;
          const lastReward = lastDay ? CHECKIN_REWARDS[lastDay - 1] : undefined;
          if (lastDay && lastReward && (lastReward.kind === 'card' || lastReward.kind === 'equipment' || lastReward.kind === 'coins' || lastReward.bonusCoins)) {
            const settled = await this.settleCheckinReward(accountId, lastDay, lastReward, tsMs);
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
      const claimedReward = reward as import('@nw/shared').CheckinReward | null;
      if (!claimedReward) return ok({ save: recorded.save, day: claimedDay, reward: claimedReward });
      const settled = await this.settleCheckinReward(accountId, claimedDay, claimedReward, tsMs);
      if ('error' in settled) {
        // Claim is durably recorded; delivery failed but is retryable (deterministic orderId) via the
        // ALREADY_CLAIMED_TODAY recovery branch above the next time this account calls /retention/checkin.
        return reply.code(502).send(err(ErrorCode.REV_CONFLICT, settled.error));
      }
      return ok({ save: settled.save, day: claimedDay, reward: settled.reward });
    }

    /** Claim daily task completion coins (idempotent: threshold not reached → 400, already claimed → 409). */
    async claimDailyReward(req: FastifyRequest, reply: FastifyReply) {
      if (!this.ensureCommercial(reply)) return;
      const accountId = accountIdOf(req);
      const { commercial, cols, now } = this.deps;
      const tsMs = now();

      const recorded = await this.mutateSave(accountId, (s) => {
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
    private async settleWeeklyChestReward(
      accountId: string,
      threshold: number,
      reward: import('@nw/shared').WeeklyChestReward,
      tsMs: number,
    ): Promise<{ save: import('@nw/shared').SaveData; reward: import('@nw/shared').WeeklyChestReward } | { error: string; code: string }> {
      const { cols, now } = this.deps;
      const weekKey = makeWeekKey(tsMs);
      let deliveredId: string | undefined;

      if (reward.kind === 'equipment') {
        const orderId = `weekly_chest_item:${accountId}:${weekKey}:${threshold}`;
        const r = await this.deliverRetentionReward(accountId, orderId, 'weekly_chest', () => {
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
      } else if (reward.kind === 'skin') {
        // Simplified from the doc's "限定皮肤碎片" (see retention.ts WEEKLY_CHEST_TIERS comment) —
        // grants a whole shop-tier skin. grantSkin is itself a no-op if already owned, but the pick
        // still goes through the same idem ledger so a retry doesn't re-roll a *different* skin.
        const orderId = `weekly_chest_item:${accountId}:${weekKey}:${threshold}`;
        const r = await this.deliverRetentionReward(accountId, orderId, 'weekly_chest', () => ({ kind: 'skin', skinId: pickWeeklyChestSkin() }));
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
     * material rewards are written synchronously in the same mutateSave; equipment/skin rewards
     * resolve their concrete item at claim time (uniform random draw, like checkin's 'card'/
     * 'equipment' milestones) and deliver via a follow-up call once the claim itself is durable.
     */
    async claimWeeklyChest(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { now } = this.deps;
      const tsMs = now();
      const { threshold } = req.body as { threshold: number };

      let reward: import('@nw/shared').WeeklyChestReward | null = null;
      const recorded = await this.mutateSave(accountId, (s) => {
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
          // durably marked claimed, possibly by an earlier request whose equipment/skin delivery then
          // failed. WEEKLY_CHEST_TIERS' reward kind is static per threshold (not derived from
          // transactional state), so it can be looked up directly without re-running claimWeeklyTier.
          const tierDef = WEEKLY_CHEST_TIERS.find((t) => t.threshold === threshold);
          if (tierDef && (tierDef.reward.kind === 'equipment' || tierDef.reward.kind === 'skin')) {
            const settled = await this.settleWeeklyChestReward(accountId, threshold, tierDef.reward, tsMs);
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
      const claimedReward = reward as import('@nw/shared').WeeklyChestReward | null;
      if (!claimedReward) return ok({ save: recorded.save, threshold, reward: claimedReward });
      const settled = await this.settleWeeklyChestReward(accountId, threshold, claimedReward, tsMs);
      if ('error' in settled) {
        // Claim is durably recorded; delivery failed but is retryable via the ALREADY_CLAIMED
        // recovery branch above the next time this account calls /retention/weekly-chest.
        return reply.code(502).send(err(ErrorCode.REV_CONFLICT, settled.error));
      }
      return ok({ save: settled.save, threshold, reward: settled.reward });
    }

    async getEvents(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { cols, now } = this.deps;
      const events = await getEventsForAccount(cols, accountId, now());
      return reply.send({ ok: true, data: { events } });
    }

    async claimEventReward(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { eventId, rewardId } = req.body as { eventId: string; rewardId: string };
      if (!eventId || !rewardId) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing eventId/rewardId'));
      const { cols, now, commercial } = this.deps;
      const socialsvc = this.deps.socialsvc ?? nullMetaSocialsvcClient;
      const result = await claimEventReward(cols, accountId, eventId, rewardId, now(), commercial, socialsvc);
      if (!result.ok) {
        const code =
          result.error === 'NOT_FOUND' ? 404 :
          result.error === 'EVENT_CLOSED' ? 403 :
          result.error === 'INSUFFICIENT_POINTS' ? 402 :
          409;
        const errCode =
          result.error === 'NOT_FOUND' ? ErrorCode.NOT_FOUND :
          result.error === 'EVENT_CLOSED' ? ErrorCode.BAD_REQUEST :
          result.error === 'INSUFFICIENT_POINTS' ? ErrorCode.INSUFFICIENT_FUNDS :
          ErrorCode.ALREADY_CLAIMED;
        return reply.code(code).send(err(errCode, result.error));
      }
      return reply.send({ ok: true, data: { pointsLeft: result.pointsLeft, reward: result.reward } });
    }

    /**
     * Aggregated lobby red-dot fetch (P1-4, comm-audit-2026-07-27): merges social badges (proxied to
     * socialsvc) + achievement defs/stats/claimed + retention claimable flags + events-available into
     * one call, replacing the 4-request waterfall goLobby() used to fire on every online lobby entry.
     * Best-effort on the social slice — socialsvc being down degrades to zeroed counts rather than
     * failing the whole response, matching the old per-call try/catch semantics on the client.
     */
    async getLobbyBadges(req: FastifyRequest) {
      const accountId = accountIdOf(req);
      const { cols, now, socialsvc } = this.deps;
      const tsMs = now();
      const auth = (req.headers.authorization ?? '') as string;
      const [save, events, socialResult] = await Promise.all([
        getOrCreateSave(cols, accountId, tsMs),
        getEventsForAccount(cols, accountId, tsMs),
        socialsvc?.available ? socialsvc.proxy('GET', '/social/badges', null, auth) : Promise.resolve(null),
      ]);
      const retention = resetStaleRetention(save.retention, tsMs);
      const social =
        socialResult && socialResult.status === 200
          ? ((socialResult.data as { data: SocialBadges }).data ?? ZERO_SOCIAL_BADGES)
          : ZERO_SOCIAL_BADGES;
      return ok({
        social,
        achievements: { defs: ACHIEVEMENTS, stats: save.stats ?? {}, achievements: save.achievements ?? {} },
        retentionClaimable: {
          checkin: nextCheckinDay(retention, tsMs) !== null,
          daily: dailyRewardClaimable(retention, tsMs),
          // 2026-08-05 fix: this hand-rolled trio used to omit the weekly chest entirely — a fully
          // week-claimed player still saw the "每日" red dot light up for checkin/daily, but a player
          // who'd ONLY earned a weekly-chest tier (checkin/daily already claimed today) saw no dot at
          // all, even though `hasRetentionClaimable` (retention.ts, used by the client mirror + its own
          // test) already accounted for weekly tiers. Kept as three explicit booleans (matching the
          // openapi contract) rather than switching to hasRetentionClaimable(save, tsMs) directly, since
          // the client badge (lobby.ts) ORs each field independently and may want to distinguish them later.
          weekly: weeklyClaimableTiers(retention, tsMs).length > 0,
        },
        eventsAvailable: events.length > 0,
      });
    }

    /** Read all titles granted to the current account (including derived source/seasonNo) + currently equipped title. */
    async getTitles(req: FastifyRequest) {
      const accountId = accountIdOf(req);
      const save = await getOrCreateSave(this.deps.cols, accountId, this.deps.now());
      const titles = (save.titles ?? []).map((id) => {
        const { source, seasonNo } = parseTitleId(id);
        return { id, source, ...(seasonNo != null ? { seasonNo } : {}) };
      });
      return ok({ titles, equipped: save.equipped?.title ?? null });
    }

    /**
     * Select the active display title → write save.equipped.title → push back the full save.
     * Only granted titles are allowed; an empty string titleId is treated as unequipping (clears the equipped title).
     */
    async equipTitle(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { titleId } = req.body as { titleId?: string };
      const out = await this.mutateSave(accountId, (s) => {
        const owned = s.titles ?? [];
        // empty string = unequip display title
        if (titleId === '' || titleId == null) {
          const { title: _drop, ...restEquipped } = s.equipped ?? {};
          return { ...s, equipped: restEquipped };
        }
        if (!owned.includes(titleId)) return 'NOT_OWNED';
        return { ...s, equipped: { ...s.equipped, title: titleId } };
      });
      if ('error' in out) {
        if (out.error === 'NOT_OWNED') {
          return reply.code(403).send(err(ErrorCode.BAD_REQUEST, 'title not owned'));
        }
        return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
      }
      return ok({ save: out.save });
    }

    /**
     * Select the displayed avatar → write save.equipped.avatar → push back the full save.
     * avatarId is a composite "<category>:<key>" (preset/title/hero/equip/material/skin), with bare
     * digits ('0'-'7') accepted for backward compat with the old localStorage-only preset picker.
     * `preset` is always allowed; every other category requires the key to appear in the account's
     * lifetime-owned records (titles[] / everOwned.* / inventory.skins) — obtained once, unlocked forever,
     * even if the item has since been salvaged/consumed/sold.
     */
    async equipAvatar(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { avatarId } = req.body as { avatarId?: string };
      const out = await this.mutateSave(accountId, (s) => {
        if (avatarId === '' || avatarId == null) {
          const { avatar: _drop, ...restEquipped } = s.equipped ?? {};
          return { ...s, equipped: restEquipped };
        }
        if (PRESET_AVATAR_IDS.has(avatarId)) {
          return { ...s, equipped: { ...s.equipped, avatar: avatarId } };
        }
        if (!isAvatarOwned(s, avatarId)) return 'NOT_OWNED';
        return { ...s, equipped: { ...s.equipped, avatar: avatarId } };
      });
      if ('error' in out) {
        if (out.error === 'NOT_OWNED') {
          return reply.code(403).send(err(ErrorCode.BAD_REQUEST, 'avatar item not owned'));
        }
        return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
      }
      return ok({ save: out.save });
    }

    /**
     * Equip/unequip a character skin → write save.equipped["skin:<unitType>"] → push back the full save.
     * One slot per character (LOBBY_IA_REDESIGN §15); skinId null unequips. The unitType→skin target
     * mapping (SKIN_TARGET_UNIT) lives only in the client (game/meta/skinDefs.ts) — the server does not
     * need it here, it only validates that the *skin itself* is owned (isSkinOwned), same depth as the
     * old sanitizeEquipped path this replaces.
     */
    async equipSkin(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { unitType, skinId } = req.body as { unitType?: string; skinId?: string | null };
      if (!unitType) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unitType required'));
      }
      const key = `skin:${unitType}`;
      const out = await this.mutateSave(accountId, (s) => {
        if (skinId === '' || skinId == null) {
          const rest = { ...s.equipped };
          delete rest[key];
          return { ...s, equipped: rest };
        }
        if (!isSkinOwned(s, skinId)) return 'NOT_OWNED';
        return { ...s, equipped: { ...s.equipped, [key]: skinId } };
      });
      if ('error' in out) {
        if (out.error === 'NOT_OWNED') {
          return reply.code(403).send(err(ErrorCode.BAD_REQUEST, 'skin not owned'));
        }
        return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
      }
      return ok({ save: out.save });
    }

    /**
     * Set one client-preference flag by key → write save.flags[key] → push back the full save.
     * No ownership semantics (unlike equipped.*) — onboarding/consent/tutorial-seen style booleans only.
     */
    async setFlag(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { key, value } = req.body as { key?: string; value?: boolean };
      if (!key || key.length > MAX_FLAG_KEY_LEN || typeof value !== 'boolean') {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'invalid key/value'));
      }
      const out = await this.mutateSave(accountId, (s) => ({ ...s, flags: { ...s.flags, [key]: value } }));
      if ('error' in out) {
        return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
      }
      return ok({ save: out.save });
    }
  };
}
