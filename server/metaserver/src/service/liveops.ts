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
  nextCheckinDay,
  dailyRewardClaimable,
  makeDayKey,
  makeMonthKey,
  parseTitleId,
  pickRandomCatalogItem,
  CARD_DEFS,
  EQUIPMENT_DEFS,
  rollCraftedAffixes,
  ADS_REWARD_COINS,
  ADS_DAILY_CAP,
  ADS_MIN_INTERVAL_MS,
  type EquipmentInstance,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { mirrorCoins, adsDayKey, peekAdsStatus } from '../economy.js';
import { grantTitleToPlayer } from '../titles.js';
import { getEventsForAccount, claimEventReward } from '../events.js';
import { nullMetaSocialsvcClient } from '../socialsvcClient.js';
import { grantCards } from '../cards.js';
import { grantEquipment } from '../equipment.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, type Constructor, type MetaBaseCtor } from './base.js';

type LiveOpsHandlers = Pick<
  MetaHandlers,
  | 'getAchievements' | 'claimAchievement' | 'getRetention' | 'claimCheckin' | 'claimDailyReward'
  | 'getEvents' | 'claimEventReward' | 'getTitles' | 'equipTitle' | 'equipAvatar'
>;

/** Preset avatar slot ids (avatar.ts AVATAR_DEFS, indices 0-7) — always unlocked, no ownership check. */
const PRESET_AVATAR_IDS = new Set(['0', '1', '2', '3', '4', '5', '6', '7']);

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
      const { cols, now } = this.deps;
      const tsMs = now();
      const save = await getOrCreateSave(cols, accountId, tsMs);
      const retention = resetStaleRetention(save.retention, tsMs);
      const adsStatus = await peekAdsStatus(cols, accountId, adsDayKey(tsMs), ADS_MIN_INTERVAL_MS, tsMs);
      return ok({
        checkin: retention.checkin ?? null,
        daily: retention.daily ?? null,
        defs: { rewards: CHECKIN_REWARDS, tasks: DAILY_TASKS, pointsThreshold: DAILY_POINTS_THRESHOLD, dailyCoinsReward: DAILY_COINS_REWARD },
        claimable: {
          checkin: nextCheckinDay(retention, tsMs) !== null,
          daily: dailyRewardClaimable(retention, tsMs),
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
        if (recorded.error === 'ALREADY_CLAIMED_TODAY') {
          return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'already claimed today'));
        }
        if (recorded.error === 'MONTH_FULL') {
          return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'month fully claimed'));
        }
        return reply.code(409).send(err(ErrorCode.REV_CONFLICT, recorded.error));
      }
      let save = recorded.save;
      let deliveredId: string | undefined;
      // `reward` was assigned inside the mutateSave closure above, so TS no longer narrows its type
      // past that point (widens to the declared `CheckinReward | null`); copy to a fresh binding so
      // the rest of the function gets ordinary control-flow narrowing.
      const claimedReward = reward as import('@nw/shared').CheckinReward | null;
      if (claimedReward) {
        const r = claimedReward;
        if (r.kind === 'coins') {
          // Coins reward (legacy path) must be delivered via commercial.
          if (!this.ensureCommercial(reply)) return;
          const { commercial, cols } = this.deps;
          const orderId = `checkin:${accountId}:${makeMonthKey(tsMs)}:${claimedDay}`;
          const g = await commercial.grant({ accountId, amount: r.count, reason: 'checkin', orderId });
          if (g.ok) save = await mirrorCoins(cols, accountId, g.coinsAfter, tsMs);
        } else if (r.kind === 'card') {
          // Card pack milestone: uniform random draw from the existing gacha card catalogue,
          // then delivered the same way a gacha pull would land it (roster cap → coin compensation).
          const picked = pickRandomCatalogItem('card');
          const def = picked ? CARD_DEFS[picked.itemId] : undefined;
          if (def) {
            const { cols, commercial, now } = this.deps;
            const g = await grantCards(cols, now, accountId, [def]);
            if (!('error' in g)) {
              save = g.save;
              deliveredId = def.id;
              if (g.compensatedCoins > 0 && commercial.available) {
                const orderId = `checkin:card_comp:${accountId}:${makeMonthKey(tsMs)}:${claimedDay}`;
                const gr = await commercial.grant({ accountId, amount: g.compensatedCoins, reason: 'checkin', orderId });
                if (gr.ok) save = await mirrorCoins(cols, accountId, gr.coinsAfter, tsMs);
              }
            }
          }
        } else if (r.kind === 'equipment') {
          // Month-end finale: uniform random draw restricted to entry-tier gear (equip_t1), rolled
          // with the same craft-affix function real crafting uses, delivered via the trade-transfer
          // writer (grantEquipment — overwrite-by-id, no cap check, matches mail/escrow delivery).
          const picked = pickRandomCatalogItem('equip_t1');
          const def = picked ? EQUIPMENT_DEFS[picked.itemId] : undefined;
          if (def) {
            const { cols, now } = this.deps;
            const instanceId = `eq_checkin_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
            const instance: EquipmentInstance = {
              id: instanceId,
              defId: def.defId,
              rarity: def.rarity,
              level: 0,
              affixes: rollCraftedAffixes(def.defId, instanceId),
            };
            const g = await grantEquipment(cols, now, accountId, instance);
            if (!('error' in g)) {
              save = await getOrCreateSave(cols, accountId, now());
              deliveredId = def.defId;
            }
          }
        }
      }
      const finalReward = claimedReward && deliveredId
        ? { kind: claimedReward.kind, count: claimedReward.count, id: deliveredId }
        : claimedReward;
      return ok({ save, day: claimedDay, reward: finalReward });
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
          return reply.code(409).send(err(ErrorCode.ALREADY_CLAIMED, 'daily reward already claimed'));
        }
        if (recorded.error === 'WRONG_DAY') {
          return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'no daily tasks completed today'));
        }
        return reply.code(409).send(err(ErrorCode.REV_CONFLICT, recorded.error));
      }
      const orderId = `daily:${accountId}:${makeDayKey(tsMs)}`;
      const g = await commercial.grant({ accountId, amount: DAILY_COINS_REWARD, reason: 'daily_task', orderId });
      if (!g.ok) return reply.code(502).send(err(ErrorCode.BAD_REQUEST, 'coin grant failed'));
      const save = await mirrorCoins(cols, accountId, g.coinsAfter, tsMs);
      return ok({ save, coins: DAILY_COINS_REWARD });
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
        const sep = avatarId.indexOf(':');
        const category = sep < 0 ? avatarId : avatarId.slice(0, sep);
        const key = sep < 0 ? '' : avatarId.slice(sep + 1);
        const owned = (() => {
          switch (category) {
            case 'preset': return true;
            case 'title': return (s.titles ?? []).includes(key);
            case 'hero': return (s.everOwned?.hero ?? []).includes(key);
            case 'equip': return (s.everOwned?.equipment ?? []).includes(key);
            case 'material': return (s.everOwned?.material ?? []).includes(key);
            case 'skin': return (s.inventory?.skins ?? []).includes(key) || (s.everOwned?.skin ?? []).includes(key);
            default: return false;
          }
        })();
        if (!owned) return 'NOT_OWNED';
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
  };
}
