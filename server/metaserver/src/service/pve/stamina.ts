// PvE stamina system (A4). Split out of pve.ts (2026-08-10, 独立函数模块 form — see pve.ts's facade
// comment). Each handler takes its dependencies as an explicit `ctx` parameter instead of a mixin's
// `this`; PveMixin's own class body supplies `ctx` by reading `this.deps` and binding the one protected
// base method (`rejectIfBanned`) pveEnter needs. No behavior change.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok, findPveLevel } from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import { accountIdOf, clientPlatformOf, STAMINA_CAP, STAMINA_REGEN_MS, type ServiceDeps } from '../base.js';
import { DEFAULT_STAMINA_COST, deductStamina } from './helpers.js';

export interface PveStaminaCtx {
  deps: ServiceDeps;
  rejectIfBanned: (cols: ServiceDeps['cols'], accountId: string, reply: FastifyReply) => Promise<boolean>;
}

/**
 * PvE level entry (A4, 2026-07-06): stamina is deducted the moment the player commits to a level,
 * not at clear — retreating or losing mid-level does not refund it (pveClear no longer touches stamina).
 * Same unlock/ban validation as pveClear.
 */
export async function pveEnterHandler(ctx: PveStaminaCtx, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { cols, now } = ctx.deps;
  const { levelId } = req.body as { levelId: string };
  const level = findPveLevel(levelId);
  if (!level) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown level'));

  if (await ctx.rejectIfBanned(cols, accountId, reply)) return;
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
