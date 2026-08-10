// PvE L1 replay spot-check re-simulation (PVE_INTEGRITY_PLAN §8.6). Split out of pve.ts (2026-08-10,
// 独立函数模块 form — see pve.ts's facade comment). `pveVerifyHandler` takes its dependencies as an
// explicit `ctx` parameter (deps + the one protected base method it needs, bound by PveMixin's class
// body) instead of a mixin's `this`. No behavior change.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SaveData, EquipmentInstance } from '@nw/shared';
import { ErrorCode, err, ok, findPveLevel, PVE_REJECT_BAN_THRESHOLD, accrueStats, accrueRetentionTask, sanitizePvpReportedStats } from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import { grantCards } from '../../cards.js';
import { toInstanceDoc } from '../../equipment.js';
import { recordMaterialGrants } from '../../material.js';
import { insertSystemMail } from '../../mail.js';
import { accrueEventTask } from '../../events.js';
import { nullMetaSocialsvcClient } from '../../socialsvcClient.js';
import { accountIdOf, type ServiceDeps } from '../base.js';
import { applyMaterialAndEquipmentGrant, prepareClearReward } from './helpers.js';

type MutateSaveFn = (
  accountId: string,
  transform: (s: SaveData) => SaveData | string,
) => Promise<{ save: SaveData } | { error: string }>;

export interface PveVerifyCtx {
  deps: ServiceDeps;
  mutateSave: MutateSaveFn;
}

/**
 * Consolidated post-verification reward delivery for the pveVerify (L1 spot-check) path — same
 * write-amplification fix as settleNormalClear (clear.ts), scoped to this caller's actual writes:
 * material/equipment grant + judged-stat accrual + daily retention task in one mutateSave (event task is
 * bumped separately by the caller, pveVerify, mirroring pveClear's B6 call). Progress/stars were already
 * written at spot-check submission time (writeClearProgress, clear.ts). Fixed 2026-07-28: this path used
 * to skip the retention/event tasks entirely, so "Clear any PvE level" silently stayed incomplete for any
 * first-time-clear-of-the-day (always spot-checked) or ~10%-sampled clear. `statsJson` is the judge's re-simulation output (only
 * passed for a 'verified' verdict — pveVerify passes undefined for 'unverified' benefit-of-doubt
 * deliveries) and is parsed the same defensive way accrueJudgedPveStats used to.
 */
async function deliverVerifiedClearReward(
  deps: ServiceDeps,
  mutateSave: MutateSaveFn,
  accountId: string,
  levelId: string,
  reward: Record<string, number>,
  statsJson: string | undefined,
  verifyId: string,
): Promise<{
  save: SaveData;
  granted: Record<string, number>;
  grantedCards: Record<string, number>;
  grantedEquipment?: EquipmentInstance;
  capped: boolean;
} | { error: string }> {
  const { cols, now } = deps;
  const { capped, grant, cardGrant, defsToGrant, pendingDrop } =
    await prepareClearReward(deps.redis, now(), accountId, levelId, reward);

  let cleanStats: Record<string, number> | undefined;
  if (statsJson) {
    try {
      const parsed = JSON.parse(statsJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const clean = sanitizePvpReportedStats(parsed as Record<string, number>);
        if (clean && Object.keys(clean).length > 0) cleanStats = clean;
      }
    } catch {
      // malformed statsJson → skip accrual, same as accrueJudgedPveStats's original try/catch
    }
  }

  // Card instance grant FIRST (2026-08-04 fix, mirrors settleNormalClear's identical fix — see its
  // comment in clear.ts for the full rationale): grantCards can independently fail under save-document
  // contention; running it before the consolidated write below means that failure leaves materials/
  // equipment-slot/accrueStats/retention completely untouched, so a retry (this path is additionally
  // guarded by pveVerify's verifyId+status CAS, but defense-in-depth costs nothing here) can't double-apply them.
  if (defsToGrant.length > 0) {
    const cardResult = await grantCards(cols, now, accountId, defsToGrant, `pve_drop:${levelId}`);
    if ('error' in cardResult) return cardResult;
  }

  let dropGranted = false;
  const out = await mutateSave(accountId, (s) => {
    const grantResult = applyMaterialAndEquipmentGrant(s, grant, pendingDrop);
    dropGranted = grantResult.dropGranted;
    let next = grantResult.next;
    if (cleanStats) {
      const stats = accrueStats(next.stats, cleanStats);
      if (stats !== next.stats) next = { ...next, stats };
    }
    // Fix (2026-07-28): spot-checked clears used to skip the daily/event "clear PvE level" tasks
    // entirely (see settleNormalClear's B5 comment in clear.ts for the counterpart on the non-spot-check path).
    // Bump it here too once the reward is actually delivered (verified or benefit-of-doubt unverified;
    // rejected clears never reach this function).
    const nextRetention = accrueRetentionTask(next.retention, 'pve.clear', now());
    if (nextRetention !== next.retention) next = { ...next, retention: nextRetention };
    return next;
  });
  if ('error' in out) return out;
  if (dropGranted && pendingDrop) {
    await cols.equipmentInstances.updateOne(
      { _id: pendingDrop.id },
      { $set: toInstanceDoc(pendingDrop, accountId) },
      { upsert: true },
    );
  }
  // Material provenance (ITEM_IDENTITY_DESIGN.md task2, 2026-08-10): best-effort, after the mutateSave
  // above has already durably committed the counter increment(s). Unlike settleNormalClear (clear.ts),
  // this path DOES have a natural per-event idempotency key — verifyId (a pveVerifications doc can only
  // transition out of 'pending' once, see pveVerifyHandler's status check) — so it's used instead of a
  // random id, making a client retry of the verify submission re-assert the same row.
  if (Object.keys(grant).length > 0) {
    await recordMaterialGrants(cols, accountId, `pve_verify_${verifyId}`, grant, `pve_drop:${levelId}`, now());
  }

  const grantedEquipment = dropGranted ? pendingDrop : undefined;
  return { save: out.save, granted: grant, grantedCards: cardGrant, grantedEquipment, capped };
}

/**
 * PvE L1 replay spot-check re-simulation (§8.6 step 3): client submits the replay frames of the flagged clear → dispatched via gateway to a third-party
 * online client for headless re-simulation (reuses S1-J, campaign mode + server-authoritative blueprint snapshot) → materials delivered only if re-simulated stars ≥ claimed.
 * If no judge is available (no candidates / timeout / re-simulation failure) → benefit-of-doubt: deliver anyway (honest players are not penalized for missing judges);
 * if re-simulated stars < claimed → flagged as suspicious, materials not delivered + recorded as rejected.
 */
export async function pveVerifyHandler(ctx: PveVerifyCtx, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { cols, gateway, now } = ctx.deps;
  const { verifyId, frames, endFrame } = req.body as {
    verifyId: string;
    frames: { frame: number; cmds: { side: number; commands: string }[] }[];
    endFrame: number;
  };
  // S4-4: banned accounts cannot submit verifications.
  const save = await cols.saves.findOne({ _id: accountId }, { projection: { 'save.antiCheat': 1 } });
  if (save?.save?.antiCheat?.pveBanned) {
    return reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account banned'));
  }
  const doc = await cols.pveVerifications.findOne({ _id: verifyId });
  if (!doc || doc.accountId !== accountId) {
    return reply.code(404).send(err(ErrorCode.NOT_FOUND, 'verification not found'));
  }
  if (doc.status !== 'pending') {
    // Already settled (duplicate submission) → idempotent: return current save, do not deliver again.
    const s = await getOrCreateSave(cols, accountId, now());
    return ok({ save: s, granted: {}, capped: false, verified: doc.status !== 'rejected' });
  }
  const level = findPveLevel(doc.levelId);
  if (!level) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown level'));

  // Dispatch third-party headless re-simulation (seed derived locally by the judge from the level JSON; mode is audit-only, PvE uses levelId).
  const verdict = await gateway.judge({
    seed: 0,
    mode: 0,
    endFrame: Math.floor(endFrame) || 0,
    frames: frames ?? [],
    exclude: [accountId],
    levelId: doc.levelId,
    cardInstancesJson: JSON.stringify(doc.cardInv ?? {}),
    equipmentInvJson: JSON.stringify(doc.equipmentInv ?? {}),
  });

  const judgedStars = verdict.stars ?? 0;
  // Re-simulation succeeded and stars < claimed → suspicious, do not deliver materials. All other outcomes (passed / no judge available) deliver materials.
  const rejected = verdict.ok && judgedStars < doc.claimedStars;
  const status: 'verified' | 'unverified' | 'rejected' = rejected
    ? 'rejected'
    : verdict.ok
      ? 'verified'
      : 'unverified';
  const settleRes = await cols.pveVerifications.updateOne(
    { _id: verifyId, status: 'pending' },
    {
      $set: {
        status,
        judgedStars,
        ...(verdict.judgeAccountId ? { judgeAccountId: verdict.judgeAccountId } : {}),
        // Archive the submitted frames only when suspicious (§8.6 待办): lets ops re-examine a disputed
        // clear later instead of only having the judge's verdict; kept out of the common verified/unverified path.
        ...(rejected ? { frames: frames ?? [], endFrame: Math.floor(endFrame) || 0 } : {}),
      },
      // A rejected doc is kept forever for ops review (mirrors MatchDoc.expireAt's disputed-match carve-out):
      // verified/unverified keep the expireAt set at insert.
      ...(rejected ? { $unset: { expireAt: '' as const } } : {}),
    },
  );
  if (settleRes.matchedCount === 0) {
    // Lost the race: a concurrent submission for this same verifyId already flipped status out of
    // 'pending' between our initial read (line 667) and this write (the gateway.judge() call above
    // can take up to ~20s, plenty of time for a duplicate/retried request to land first). Take the
    // same idempotent path as the up-front check — do not deliver rewards a second time.
    const s = await getOrCreateSave(cols, accountId, now());
    const settled = await cols.pveVerifications.findOne({ _id: verifyId });
    return ok({ save: s, granted: {}, capped: false, verified: settled?.status !== 'rejected' });
  }

  if (rejected) {
    // No automatic ban (design decision, 2026-07-18): a rejection only means the re-simulation
    // yielded fewer stars than claimed, which can also happen to a legitimate, heavily-invested
    // account clearing early content passively (base/hero auto-attack alone, no card played that
    // tick) — see PVE_INTEGRITY_PLAN.md fairness note. Every rejection now files an ops review
    // ticket instead; a human decides whether to ban via the anti-cheat review queue.
    let rejectCount = 1;
    const saved = await ctx.mutateSave(accountId, (s) => {
      const ac = s.antiCheat ?? { statSuspicion: 0 };
      rejectCount = (ac.pveRejectCount ?? 0) + 1;
      return {
        ...s,
        antiCheat: {
          ...ac,
          pveRejectCount: rejectCount,
          lastFlaggedTs: now(),
        },
      };
    });
    await cols.pveRejections.insertOne({
      _id: verifyId,
      accountId,
      levelId: doc.levelId,
      claimedStars: doc.claimedStars,
      judgedStars,
      rejectCountAfter: rejectCount,
      banned: false,
      ts: now(),
    });

    // C4: account-level pveWarnings count (visibility only, no longer a ban trigger) + warning mail every time.
    const updatedAcc = await cols.accounts.findOneAndUpdate(
      { _id: accountId },
      { $inc: { 'flags.pveWarnings': 1 } },
      { returnDocument: 'after', projection: { 'flags.pveWarnings': 1, publicId: 1 } },
    );
    // Best-effort: a failed warning mail must not block the reject-count/review flow above.
    await insertSystemMail(ctx.deps.socialsvc ?? nullMetaSocialsvcClient, `pve-warn-${verifyId}`, accountId, {
      subject: 'Fair Play Warning',
      body: 'Unusual PvE activity was detected. Repeated flags may be reviewed by our team.',
      expireDays: 30,
    }).catch((e) => req.log.warn({ err: e }, 'pve-warn mail failed'));

    // File an ops review ticket (anticheat.view/anticheat.action queue) — human decides ban vs dismiss.
    // severity escalates at the old auto-ban threshold, as a repeat-offender signal for ops triage (not an automatic action).
    await cols.antiCheatReviews.insertOne({
      _id: `pve:${verifyId}`,
      kind: 'pve_reject',
      accountId,
      ...(updatedAcc?.publicId ? { publicId: updatedAcc.publicId } : {}),
      levelId: doc.levelId,
      claimedStars: doc.claimedStars,
      judgedStars,
      rejectCountAfter: rejectCount,
      severity: rejectCount >= PVE_REJECT_BAN_THRESHOLD ? 'high' : 'normal',
      status: 'open',
      ts: now(),
    });

    const s = 'error' in saved ? await getOrCreateSave(cols, accountId, now()) : saved.save;
    return ok({ save: s, granted: {}, capped: false, verified: false });
  }
  // PvE stat feed (S9-3b, ACHIEVEMENT_DESIGN §6.2): only when the **judge successfully re-simulated** (status==='verified', not benefit-of-doubt 'unverified'),
  // accumulate the judge-authoritative in-match kill/cast counts into lifetime stats, in the same
  // consolidated write as the material/equipment grant (deliverVerifiedClearReward).
  // The judge is a random third-party headless re-simulation → players cannot fabricate it; still passes through L1 caps as a cheap backstop against
  // "player colluding with the judge to farm stats" (out-of-bounds data discarded entirely, does not block material delivery). A2: counts are only written at this server-authoritative settlement point.
  const granted = await deliverVerifiedClearReward(
    ctx.deps,
    ctx.mutateSave,
    accountId,
    doc.levelId,
    level.reward,
    status === 'verified' ? verdict.statsJson : undefined,
    verifyId,
  );
  if ('error' in granted) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, granted.error));
  // B6 counterpart for the spot-check path (best-effort, mirrors the normal-clear path in pveClear).
  accrueEventTask(cols, accountId, 'pve.clear', now()).catch(() => {});
  return ok({
    save: granted.save,
    granted: granted.granted,
    grantedCards: granted.grantedCards,
    ...(granted.grantedEquipment ? { grantedEquipment: granted.grantedEquipment } : {}),
    capped: granted.capped,
    verified: true,
  });
}
