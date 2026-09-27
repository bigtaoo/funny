// PvE stamina system (A4). Split out of pve.ts (2026-08-10, 独立函数模块 form — see pve.ts's facade
// comment). `pveEnterHandler` takes `core: MetaCore` directly (2026-08-11 ctx-bind cleanup — see
// base.ts's header). No behavior change.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ErrorCode, err, ok, findPveLevel, bumpCappedCounter, readCounterField,
  STAMINA_AD_AMOUNT, STAMINA_AD_DAILY_CAP, STAMINA_AD_CLIENT_PLATFORM,
  type RedisLike,
} from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import { accountIdOf, clientPlatformOf, STAMINA_CAP, STAMINA_REGEN_MS, type ServiceDeps, type MetaCore } from '../base.js';
import { DEFAULT_STAMINA_COST, deductStamina, grantStamina } from './helpers.js';
import { adsDayKey, hashAdToken, recordAdToken } from '../../economy.js';

/**
 * PvE level entry (A4, 2026-07-06): stamina is deducted the moment the player commits to a level,
 * not at clear — retreating or losing mid-level does not refund it (pveClear no longer touches stamina).
 * Same unlock/ban validation as pveClear.
 */
export async function pveEnterHandler(core: MetaCore, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { cols, now } = core.deps;
  const { levelId } = req.body as { levelId: string };
  const level = findPveLevel(levelId);
  if (!level) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown level'));

  if (await core.rejectIfBanned(cols, accountId, reply)) return;
  const cur = await getOrCreateSave(cols, accountId, now());
  if (cur.antiCheat?.pveBanned) {
    return reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account banned'));
  }
  if (level.requires && !cur.progress.cleared.includes(level.requires)) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'level locked'));
  }

  const staminaCost = level.staminaCost ?? DEFAULT_STAMINA_COST;
  const staminaResult = await deductStamina(cols, accountId, staminaCost, now());
  if (!staminaResult.ok) {
    return reply.code(402).send(err(ErrorCode.INSUFFICIENT_STAMINA, 'not enough stamina'));
  }
  return ok({ stamina: { current: staminaResult.current, regenAt: staminaResult.regenAt } });
}

/** Purchase stamina (deducts coins via commercial; 60 stamina = 30 coins, §A4). */
export async function purchaseStaminaHandler(deps: ServiceDeps, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { commercial, now: nowFn } = deps;
  const now = nowFn();
  const CAP = STAMINA_CAP;
  const REGEN_MS = STAMINA_REGEN_MS;
  const { amount } = req.body as { amount: number };
  if (amount !== 60) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'amount must be 60'));
  }
  const COST_COINS = 30;
  const orderId = randomUUID();
  const spendRes = await commercial.spend({ accountId, amount: COST_COINS, reason: 'stamina_purchase', orderId, clientPlatform: clientPlatformOf(req) });
  if (!spendRes.ok) {
    return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough coins'));
  }
  // Add stamina (capped at CAP; excess is discarded).
  const { cols } = deps;
  await cols.pveStamina.updateOne(
    { _id: accountId },
    { $setOnInsert: { _id: accountId, current: CAP, regenAt: 0 } },
    { upsert: true },
  );
  const stDoc = await cols.pveStamina.findOne({ _id: accountId });
  const curCurrent = stDoc?.current ?? CAP;
  const newCurrent = Math.min(CAP, curCurrent + amount);
  const newRegenAt = newCurrent >= CAP ? 0 : (stDoc?.regenAt ?? 0) !== 0 ? (stDoc?.regenAt ?? 0) : now + REGEN_MS;
  await cols.pveStamina.updateOne({ _id: accountId }, { $set: { current: newCurrent, regenAt: newRegenAt } });
  return ok({ stamina: { current: newCurrent, regenAt: newRegenAt } });
}

/**
 * Rewarded-ad stamina refill (CRAZYGAMES_LAUNCH §4, 2026-09-27): +STAMINA_AD_AMOUNT per watched ad,
 * STAMINA_AD_DAILY_CAP per UTC day on its own counter (`adsStamina`, not the coin ads' `adsDaily`).
 * Served to the CrazyGames build only — every other build has no such button, and the web build
 * shares its origin with the iOS shell, whose stamina must stay coin-only. The portal SDK has no
 * server callback, so like the coin ads the token is client-issued: the cap plus token dedup are the
 * whole guard.
 */
export async function adStaminaHandler(core: MetaCore, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  if (clientPlatformOf(req) !== STAMINA_AD_CLIENT_PLATFORM) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'stamina ads are not offered on this platform'));
  }
  const { adToken } = req.body as { adToken: string };
  if (!adToken) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing adToken'));
  const { cols, redis, now } = core.deps;
  if (await core.rejectIfBanned(cols, accountId, reply)) return;
  const ts = now();
  const dayKey = adsDayKey(ts);
  // Dedup before the cap, so a replayed token cannot burn one of the player's daily refills.
  if (!(await recordAdToken(cols, hashAdToken(adToken), accountId, ts))) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'duplicate adToken'));
  }
  const used = await bumpStaminaAdCount(redis, accountId, dayKey);
  if (used === null) {
    return reply.code(429).send(err(ErrorCode.DAILY_CAP_REACHED, 'daily stamina ad cap reached'));
  }
  const stamina = await grantStamina(cols, accountId, STAMINA_AD_AMOUNT, ts);
  return ok({ stamina, adsLeft: Math.max(0, STAMINA_AD_DAILY_CAP - used) });
}

/** Claim one of today's stamina-ad slots: the count after this one, or null when the cap is already used up. */
async function bumpStaminaAdCount(redis: RedisLike | null, accountId: string, dayKey: string): Promise<number | null> {
  if (!(await bumpCappedCounter(redis, 'adsStamina', accountId, dayKey, 'count', STAMINA_AD_DAILY_CAP))) return null;
  return readCounterField(redis, 'adsStamina', accountId, dayKey, 'count');
}
