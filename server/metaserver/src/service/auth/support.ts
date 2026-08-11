// submitAppeal/submitFeedback (2026-08-11 split of service/auth.ts — see auth.ts's shell comment for
// the overall split rationale/module map).
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, err, ok } from '@nw/shared';
import { APPEAL_REASON_MAX } from '@nw/shared';
import { FEEDBACK_TEXT_MAX } from '@nw/shared';
import { accountIdOf, clientPlatformOf, type RateLimiter, type ServiceDeps } from '../base.js';

/**
 * Submit an appeal against the account's currently active mute/temp-ban/ban (CONTENT_MODERATION_DESIGN.md
 * CM10). Only allowed while an enforcement is actually active (a healed/expired mute or a long-past temp
 * ban has nothing left to appeal), and only one open appeal at a time per account (prevents spam re-submits
 * while the first is still pending review).
 */
export async function submitAppealHandler(deps: ServiceDeps, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { reason } = req.body as { reason: string };
  const trimmed = reason.trim();
  if (!trimmed) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'reason required'));

  const { cols, now } = deps;
  const existingOpen = await cols.appeals.findOne({ accountId, status: 'open' });
  if (existingOpen) {
    return reply.code(409).send(err(ErrorCode.ALREADY_REQUESTED, 'an appeal is already pending for this account'));
  }

  const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { flags: 1 } });
  const nowMs = now();
  const flags = doc?.flags;
  const bannedUntilActive = !!flags?.bannedUntil && flags.bannedUntil > nowMs;
  const mutedUntilActive = !!flags?.mutedUntil && flags.mutedUntil > nowMs;
  if (!flags?.banned && !bannedUntilActive && !mutedUntilActive) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'no active enforcement to appeal'));
  }

  try {
    await cols.appeals.insertOne({
      _id: randomUUID(),
      accountId,
      reason: trimmed.slice(0, APPEAL_REASON_MAX),
      enforcementSnapshot: {
        ...(flags?.banned ? { banned: true } : {}),
        ...(bannedUntilActive ? { bannedUntil: flags!.bannedUntil } : {}),
        ...(mutedUntilActive ? { mutedUntil: flags!.mutedUntil } : {}),
        ...(typeof flags?.reputationScore === 'number' ? { reputationScore: flags.reputationScore } : {}),
      },
      status: 'open',
      createdAt: nowMs,
    });
  } catch (e) {
    // Unique partial index on {accountId, status:'open'} (mongo.ts) is the atomic backstop behind the
    // findOne check above: two concurrent submits from the same account can both pass that read, but
    // only one insertOne wins here.
    if ((e as { code?: number }).code === 11000) {
      return reply.code(409).send(err(ErrorCode.ALREADY_REQUESTED, 'an appeal is already pending for this account'));
    }
    throw e;
  }
  return ok({ ok: true });
}

/**
 * Player free-text feedback (UI_DESIGN.md §4.1.1 lobby entry, SERVER_API.md §2.13). Ops-review-only via
 * GET /internal/feedback (feedback.view) — no status machine, unlike submitAppeal above. Multiple
 * submissions per account are allowed (not a "one open ticket" model), guarded only by the rate limit.
 */
export async function submitFeedbackHandler(
  deps: ServiceDeps,
  feedbackRate: RateLimiter,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const accountId = accountIdOf(req);
  const { text } = req.body as { text: string };
  const trimmed = text.trim();
  if (!trimmed) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'text required'));

  if (!(await feedbackRate.allow(accountId, deps.now()))) {
    return reply.code(429).send(err(ErrorCode.RATE_LIMITED, 'too many feedback submissions, please try again later'));
  }

  const { cols, now } = deps;
  await cols.feedback.insertOne({
    _id: randomUUID(),
    accountId,
    text: trimmed.slice(0, FEEDBACK_TEXT_MAX),
    clientPlatform: clientPlatformOf(req),
    createdAt: now(),
  });
  return ok({ ok: true });
}
