// PvE normal-clear settlement + the L1 spot-check decision (PVE_INTEGRITY_PLAN §8). Split out of
// pve.ts (2026-08-10, 独立函数模块 form — see pve.ts's facade comment). `pveClearHandler` takes its
// dependencies as an explicit `ctx` parameter (deps + the three protected base methods it needs, bound
// by PveMixin's class body) instead of a mixin's `this`. No behavior change.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SaveData, EquipmentInstance } from '@nw/shared';
import { ErrorCode, err, ok, findPveLevel, shouldSpotCheck, sanitizePvpReportedStats, accrueStats, levelCardReward, accrueRetentionTask } from '@nw/shared';
import { getOrCreateSave } from '../../save.js';
import { grantCards, assembleCardInv } from '../../cards.js';
import { toInstanceDoc, assembleEquipmentInv } from '../../equipment.js';
import { recordMaterialGrants } from '../../material.js';
import { insertSystemMail } from '../../mail.js';
import { accrueEventTask } from '../../events.js';
import { nullMetaSocialsvcClient } from '../../socialsvcClient.js';
import { accountIdOf, type ServiceDeps } from '../base.js';
import {
  applyClearProgress,
  applyMaterialAndEquipmentGrant,
  grantChapterClearCard,
  normUpgrades,
  prepareClearReward,
  PVE_VERIFICATION_RETENTION_MS,
  WELCOME_MAIL_DISPATCH_KEY,
} from './helpers.js';

type MutateSaveFn = (
  accountId: string,
  transform: (s: SaveData) => SaveData | string,
) => Promise<{ save: SaveData } | { error: string }>;

export interface PveClearCtx {
  deps: ServiceDeps;
  rejectIfBanned: (cols: ServiceDeps['cols'], accountId: string, reply: FastifyReply) => Promise<boolean>;
  mutateSave: MutateSaveFn;
  readStaminaSnapshot: (accountId: string, now: number) => Promise<{ current: number; regenAt: number }>;
}

/**
 * Write progress/stars (unlock + record stars, taking the max), without touching materials.
 * Also detects a first chapter clear and reports it via `newlyClearedChapter` (the `ch{N}` id) so the
 * caller can grant the chapter-clear exclusive card (§4). Detection compares the chapter finale-count
 * of prior vs new cleared inside the same rev-guarded transaction, so it fires exactly once per chapter
 * (cleared is monotonic; a replay leaves cleared unchanged → no re-fire; a concurrent duplicate loses the
 * rev race and re-reads a cleared that already contains the finale → no double-fire).
 */
async function writeClearProgress(
  mutateSave: MutateSaveFn,
  accountId: string,
  levelId: string,
  stars: number,
): Promise<{ save: SaveData; newlyClearedChapter?: string } | { error: string }> {
  let newlyClearedChapter: string | undefined;
  const out = await mutateSave(accountId, (s) => {
    const r = applyClearProgress(s, levelId, stars);
    newlyClearedChapter = r.newlyClearedChapter;
    return r.next;
  });
  if ('error' in out) return out;
  return { save: out.save, newlyClearedChapter };
}

/**
 * Consolidated normal-clear settlement (2026-07-27 write-amplification audit). Before this, one level
 * clear did up to 4 separate full-document read-modify-writes of the save (writeClearProgress,
 * grantClearReward's material/equipment write, accrueJudgedPveStats, bumpRetentionTask) — each its own
 * mutateSave call, each re-reading and rewriting the same document. None of their SaveData mutations
 * depend on each other's *results* (only prepareClearReward's daily-cap check and equipment dice roll
 * must be decided before entering the transform), so progress/stars/chapter-stat, material +
 * equipment-slot grant, judged-stat accrual, and the daily retention-task bump now land in ONE
 * mutateSave call. grantChapterClearCard and the card-drop grant stay separate calls: both go through
 * the shared grantCards primitive (also used by gacha/mail/auction), which owns its own rev-guarded
 * writes (cardInvCount mirror + the `cardInstances` collection) and must not be duplicated here.
 */
async function settleNormalClear(
  deps: ServiceDeps,
  mutateSave: MutateSaveFn,
  accountId: string,
  levelId: string,
  stars: number,
  reward: Record<string, number>,
  clientStats: Record<string, number> | undefined,
): Promise<{
  save: SaveData;
  granted: Record<string, number>;
  grantedCards: Record<string, number>;
  grantedEquipment?: EquipmentInstance;
  capped: boolean;
  newlyClearedChapter?: string;
} | { error: string }> {
  const { cols, now } = deps;
  const { capped, grant, cardGrant, defsToGrant, pendingDrop } =
    await prepareClearReward(deps.redis, now(), accountId, levelId, reward);

  // PvE stat feed (S9-3b): passes through sanitizePvpReportedStats (L1 caps as a backstop against
  // "colluding with the judge to farm stats"; out-of-bounds data is discarded entirely, without blocking
  // material delivery). Empty/invalid input → no accrual.
  let cleanStats: Record<string, number> | undefined;
  if (clientStats) {
    const clean = sanitizePvpReportedStats(clientStats);
    if (clean && Object.keys(clean).length > 0) cleanStats = clean;
  }

  // Card instance grant at level 1 FIRST (2026-08-04 fix — was previously called AFTER the consolidated
  // write below). grantCards has its own independent rev-guarded retry loop and can fail on its own
  // under save-document contention; running it first means that failure leaves progress/materials/
  // equipment-slot/accrueStats/retention completely untouched, so a client retry of this whole request
  // re-enters cleanly with nothing committed yet. The old order let this call fail AFTER the consolidated
  // write had already landed — a client retry then re-ran the whole consolidated transform from scratch
  // and double-applied every additive field in it (materials via applyMaterialAndEquipmentGrant, and
  // achievement stats via accrueStats) on top of the already-committed delta, since neither is itself
  // idempotent across repeated calls with the same clear/reward inputs. Level 1 matches every other card
  // source (starters / auction / gacha, §12); players raise cards via feeding, not the drop tier.
  if (defsToGrant.length > 0) {
    const cardResult = await grantCards(cols, now, accountId, defsToGrant, `pve_drop:${levelId}`);
    if ('error' in cardResult) return cardResult;
  }

  // ── One consolidated read-modify-write ──
  let newlyClearedChapter: string | undefined;
  let dropGranted = false;
  const out = await mutateSave(accountId, (s) => {
    const progressResult = applyClearProgress(s, levelId, stars);
    newlyClearedChapter = progressResult.newlyClearedChapter;
    const grantResult = applyMaterialAndEquipmentGrant(progressResult.next, grant, pendingDrop);
    dropGranted = grantResult.dropGranted;
    let next = grantResult.next;
    if (cleanStats) {
      const stats = accrueStats(next.stats, cleanStats);
      if (stats !== next.stats) next = { ...next, stats };
    }
    // B5: record daily task "clear PvE" (idempotent, no-op if already recorded today) in the same write.
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
  // above has already durably committed the counter increment(s). Unlike every other grant site in this
  // module, a plain PvE clear has no pre-existing per-event idempotency key (no orderId/verifyId — this
  // is the non-spot-checked path), so a fresh random id is used; a client retry minting a second
  // provenance row here is a harmless, self-expiring blemish (see MaterialInstance's doc comment) since
  // this ledger is never read back to reconstruct state.
  if (Object.keys(grant).length > 0) {
    await recordMaterialGrants(cols, accountId, randomUUID(), grant, `pve_drop:${levelId}`, now());
  }

  const grantedEquipment = dropGranted ? pendingDrop : undefined;
  return {
    save: out.save,
    granted: grant,
    grantedCards: cardGrant,
    grantedEquipment,
    capped,
    newlyClearedChapter,
  };
}

/**
 * PvE clear settlement: validate unlock → write progress/stars → deliver materials (within daily cap) → push back.
 * L1 spot-check (§8.6 step 3): if selected (first clear / blueprint anomaly / random) and a judge is available, **do not deliver materials yet**;
 * record a pveVerifications entry and respond with `needsReplay + verifyId` so the client can submit the replay to /pve/verify for re-simulation and credit.
 */
export async function pveClearHandler(ctx: PveClearCtx, req: FastifyRequest, reply: FastifyReply) {
  const accountId = accountIdOf(req);
  const { cols, now, gateway } = ctx.deps;
  const { levelId, stars: starsRaw, pveUpgrades: clientUpgradesLegacy, unitLevels: clientUnitLevels, stats: clientStats } = req.body as {
    levelId: string;
    stars: number;
    /** @deprecated S3-2, replaced by unitLevels from S12 onwards. */
    pveUpgrades?: Record<string, number>;
    /** S12 unit progression level snapshot (client snapshot at match start, used for L0 anomaly detection). */
    unitLevels?: Record<string, number>;
    /** S9-3b: client-reported in-match kill/cast stats (used for achievement counting on the non-spot-check path). */
    stats?: Record<string, number>;
  };
  const level = findPveLevel(levelId);
  if (!level) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown level'));
  const stars = Math.floor(starsRaw);
  if (stars < 1 || stars > 3) {
    // A clear requires at least 1 star; 0 stars does not count as cleared (consistent with the stars>0 gate in the client's applyCampaignClear).
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'stars must be 1..3'));
  }

  if (await ctx.rejectIfBanned(cols, accountId, reply)) return;
  const cur = await getOrCreateSave(cols, accountId, now());
  if (cur.antiCheat?.pveBanned) {
    return reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account banned'));
  }
  // Prerequisite unlock check: the prerequisite level must already be cleared (newly offline-unlocked levels are rejected, §8 decision 4).
  if (level.requires && !cur.progress.cleared.includes(level.requires)) {
    return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'level locked'));
  }

  // Author welcome mail (ONBOARDING_DESIGN §5.1): fires once, on this account's very first-ever level
  // clear (ch0_tutorial doesn't touch progress.cleared, so for a normal FTUE path this is ch1_lv1).
  // Independent of reward legitimacy/spot-check below — it's a fixed one-time thank-you, not a farmable
  // reward. Best-effort: a failed send must not block clear settlement; dispatchKey makes retries a no-op.
  if (cur.progress.cleared.length === 0) {
    const mailResult = await insertSystemMail(ctx.deps.socialsvc ?? nullMetaSocialsvcClient, WELCOME_MAIL_DISPATCH_KEY, accountId, {
      subject: 'mail.welcome.author.subject',
      body: 'mail.welcome.author.body',
      attachments: [{ kind: 'coins', count: 1000 }],
      expireDays: 30,
    }).catch((e) => {
      req.log.warn({ err: e }, 'welcome-author mail failed');
      return null;
    });
    if (mailResult?.inserted) {
      void gateway.push(accountId, { kind: 'mail_new', mailId: mailResult.mailId, hasAttachment: mailResult.hasAttachment });
    }
  }

  // Stamina is deducted at /pve/enter (A4, 2026-07-06), not here — clear settlement no longer touches it.

  // Exploitable reward = either material reward or unit card drop is non-empty (S12-C: cards are also a cheatable reward).
  const hasReward =
    Object.keys(level.reward).length > 0 || Object.keys(levelCardReward(levelId)).length > 0;

  // L1 spot-check decision: only considered when "rewards are available + judge is available" (otherwise there is no exploitable reward to cheat).
  if (hasReward && gateway.available) {
    const isFirstClear = !cur.progress.cleared.includes(levelId);
    // L0 anomaly (§0 "combat power mismatch at match start → must be cheating"): S12 prefers comparing unitLevels; falls back to pveUpgrades if unavailable.
    const blueprintMismatch = clientUnitLevels !== undefined
      ? JSON.stringify(normUpgrades(clientUnitLevels)) !== JSON.stringify(normUpgrades({}))
      : clientUpgradesLegacy !== undefined &&
        JSON.stringify(normUpgrades(clientUpgradesLegacy)) !== JSON.stringify(normUpgrades(cur.pveUpgrades));
    if (shouldSpotCheck({ isFirstClear, blueprintMismatch, rand: Math.random() })) {
      const reason = blueprintMismatch ? 'anomaly' : isFirstClear ? 'first' : 'sample';
      // Write progress/stars (unlock proceeds normally) but do not deliver materials; record the spot-check and wait for the client to submit the replay for re-simulation.
      const prog = await writeClearProgress(ctx.mutateSave, accountId, levelId, stars);
      if ('error' in prog) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, prog.error));
      // Chapter-clear exclusive card (§4): tied to the first-chapter-clear detection (same trigger as the
      // campaign.chaptersCleared stat, which is also written here on the spot-check path) — it is a one-time,
      // non-farmable reward, so it is granted alongside progress rather than deferred to /pve/verify (which
      // withholds only the farmable material reward). Delivered on this path so it fires exactly once.
      let progSave = prog.save;
      if (prog.newlyClearedChapter) {
        const s2 = await grantChapterClearCard(cols, now, ctx.deps.commercial, accountId, prog.newlyClearedChapter);
        if (s2) progSave = s2;
      }
      const verifyId = randomUUID();
      await cols.pveVerifications.insertOne({
        _id: verifyId,
        accountId,
        levelId,
        claimedStars: stars,
        // CC-1 Hero Roster snapshot (2026-07-26 fix, PVE_INTEGRITY §9): server-authoritative, taken at settlement
        // time — feeds the L1 judge re-simulation blueprint so a legitimately progressed account isn't recomputed
        // with unleveled, gear-less units (previously pveUpgrades/unitLevels, both dead since the engine dropped
        // those params in the CC-1 migration; see server/engine/src/types.ts GameConfig).
        // cardInv was split into its own `cardInstances` collection (2026-07-27, cards.ts) —
        // `cur.cardInv` is no longer populated on the raw save doc, so reassemble it explicitly.
        cardInv: await assembleCardInv(cols, accountId, cur),
        // equipmentInv was split into its own `equipmentInstances` collection (2026-07-26, equipment.ts) —
        // `cur.equipmentInv` is no longer populated on the raw save doc, so reassemble it explicitly.
        equipmentInv: await assembleEquipmentInv(cols, accountId, cur),
        reason,
        status: 'pending',
        // S9-3b: store client-reported counts as an audit comparison baseline (verdict.statsJson is the authoritative source; the reported field is for ops visibility only).
        ...(clientStats ? { reportedStats: clientStats } : {}),
        ts: now(),
        expireAt: new Date(now() + PVE_VERIFICATION_RETENTION_MS),
      });
      const saveWithSt = { ...progSave, stamina: await ctx.readStaminaSnapshot(accountId, now()) };
      return ok({
        save: saveWithSt,
        granted: {},
        grantedCards: {},
        capped: false,
        needsReplay: true,
        verifyId,
      });
    }
  }

  // Normal clear: progress/stars + materials/cards/judged-stats/retention settle in one consolidated
  // write (settleNormalClear, 2026-07-27 — previously 4 separate full-document mutateSave calls).
  const granted = await settleNormalClear(ctx.deps, ctx.mutateSave, accountId, levelId, stars, level.reward, clientStats);
  if ('error' in granted) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, granted.error));
  // Chapter-clear exclusive card (§4): fires once per chapter (first-clear detection), granted after the
  // consolidated write so its own re-read of the save reflects the level-2 anchor card in the response.
  let latestSave = granted.save;
  if (granted.newlyClearedChapter) {
    const s2 = await grantChapterClearCard(cols, now, ctx.deps.commercial, accountId, granted.newlyClearedChapter);
    if (s2) latestSave = s2;
  }
  // B6: record event task "pve.clear" (best-effort).
  accrueEventTask(cols, accountId, 'pve.clear', now()).catch(() => {});
  const saveWithSt = { ...latestSave, stamina: await ctx.readStaminaSnapshot(accountId, now()) };
  return ok({
    save: saveWithSt,
    granted: granted.granted,
    grantedCards: granted.grantedCards,
    ...(granted.grantedEquipment ? { grantedEquipment: granted.grantedEquipment } : {}),
    capped: granted.capped,
  });
}
