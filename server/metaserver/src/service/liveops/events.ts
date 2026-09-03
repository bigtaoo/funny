// Live-ops limited-time events (B6). Split out of liveops.ts (2026-08-10, 独立函数模块 form — see
// liveops.ts's facade comment). Both handlers only ever touched `this.deps`, never a protected base
// method, so they take plain `deps` with no ctx/binding needed. No behavior change.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err } from '@nw/shared';
import { getEventsForAccount, claimEventReward } from '../../events.js';
import { nullMetaSocialsvcClient } from '../../socialsvcClient.js';
import { accountIdOf, type ServiceDeps } from '../base.js';

export async function getEventsHandler(deps: ServiceDeps, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { cols, now } = deps;
  const events = await getEventsForAccount(cols, accountId, now());
  return reply.send({ ok: true, data: { events } });
}

export async function claimEventRewardHandler(deps: ServiceDeps, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { eventId, rewardId } = req.body as { eventId: string; rewardId: string };
  if (!eventId || !rewardId) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'missing eventId/rewardId'));
  const { cols, now, commercial } = deps;
  const socialsvc = deps.socialsvc ?? nullMetaSocialsvcClient;
  const result = await claimEventReward(cols, accountId, eventId, rewardId, now(), commercial, socialsvc);
  if (!result.ok) {
    // REWARD_MISCONFIGURED is a 500 on purpose: the player did nothing wrong and was not charged, the
    // event definition is broken, and a 5xx is what actually reaches ops' alerting so the reward gets
    // repaired instead of quietly refusing every claim (see claimEventReward's guard).
    const code =
      result.error === 'NOT_FOUND' ? 404 :
      result.error === 'EVENT_CLOSED' ? 403 :
      result.error === 'INSUFFICIENT_POINTS' ? 402 :
      result.error === 'REWARD_MISCONFIGURED' ? 500 :
      409;
    const errCode =
      result.error === 'NOT_FOUND' ? ErrorCode.NOT_FOUND :
      result.error === 'EVENT_CLOSED' ? ErrorCode.BAD_REQUEST :
      result.error === 'INSUFFICIENT_POINTS' ? ErrorCode.INSUFFICIENT_FUNDS :
      result.error === 'REWARD_MISCONFIGURED' ? ErrorCode.INTERNAL :
      ErrorCode.ALREADY_CLAIMED;
    return reply.code(code).send(err(errCode, result.error));
  }
  return reply.send({ ok: true, data: { pointsLeft: result.pointsLeft, reward: result.reward } });
}
