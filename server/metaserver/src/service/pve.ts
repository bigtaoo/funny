// PvE server authority (PVE_INTEGRITY_PLAN §8) + stamina system (A4).
// Clear settlement, L1 replay spot-check re-simulation, stamina purchase, and unit upgrades.
// progress/stars/materials/pveUpgrades are written ONLY here (and in ranked settlement) — putSave
// does not accept them (trust boundary, §8.3).
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SaveData, CardDef, EquipmentInstance } from '@nw/shared';
import {
  ErrorCode,
  err,
  ok,
  findPveLevel,
  findPveUpgrade,
  pveUpgradeCost,
  PVE_DAILY_CLEAR_REWARD_CAP,
  PVE_REJECT_BAN_THRESHOLD,
  shouldSpotCheck,
  chaptersClearedCount,
  sanitizePvpReportedStats,
  accrueStats,
  CARD_DEFS,
  chapterOf,
  chapterAnchorCard,
  CHAPTER_ANCHOR_CARD_LEVEL,
  levelCardReward,
  parseCardKey,
  makeDropInstance,
  EQUIPMENT_INV_CAP,
  accrueRetentionTask,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { grantCards, assembleCardInv } from '../cards.js';
import { toInstanceDoc, assembleEquipmentInv } from '../equipment.js';
import { insertSystemMail } from '../mail.js';
import { accrueEventTask } from '../events.js';
import { nullMetaSocialsvcClient } from '../socialsvcClient.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, clientPlatformOf, STAMINA_CAP, STAMINA_REGEN_MS, type Constructor, type MetaBaseCtor } from './base.js';

type PveHandlers = Pick<MetaHandlers, 'purchaseStamina' | 'pveEnter' | 'pveClear' | 'pveVerify' | 'pveUpgrade'>;

/** pveVerifications TTL (2026-07-27 audit finding: this collection had no expiry at all). Only applies to
 * verified/unverified outcomes — a `rejected` verdict unsets it (kept forever for ops review, like a
 * disputed match's MatchDoc.expireAt), since that's the small minority that actually carries replay frames. */
const PVE_VERIFICATION_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** Default stamina cost per level (A4, flat rate 2026-07-06): overridable per-level via PveLevelConfig.staminaCost. */
const DEFAULT_STAMINA_COST = 10;

/** Normalize the upgrade map (remove zero-value entries + sort keys) for stable cross-source comparison (L0 blueprint anomaly detection). */
function normUpgrades(u: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(u).sort()) {
    const v = u[k] ?? 0;
    if (v > 0) out[k] = v;
  }
  return out;
}

/**
 * Pure computation shared by writeClearProgress (spot-check path) and the consolidated normal-clear
 * transform below: advance progress/stars, bump the chaptersCleared achievement stat on a first chapter
 * clear, and report whether this call is the one that newly cleared a chapter (drives the chapter-card
 * grant). No I/O — safe to call from inside a mutateSave transform (which may run more than once on retry).
 */
function applyClearProgress(
  s: SaveData,
  levelId: string,
  stars: number,
): { next: SaveData; newlyClearedChapter?: string } {
  const cleared = s.progress.cleared.includes(levelId)
    ? s.progress.cleared
    : [...s.progress.cleared, levelId];
  const stars2 = Math.max(s.progress.stars[levelId] ?? 0, stars) as 1 | 2 | 3;
  // Achievement stat (S9-3, ACHIEVEMENT_DESIGN §4.2.2): accumulate campaign.chaptersCleared on first chapter clear.
  // $max semantics → increments only on first clear, not on replays. Lazy default creation: if no chapters
  // cleared (count=0) and no existing stats, stats is not instantiated (saves storage).
  const chapters = chaptersClearedCount(cleared);
  const prevChapters = s.stats?.['campaign.chaptersCleared'] ?? 0;
  const stats =
    chapters > prevChapters
      ? { ...(s.stats ?? {}), 'campaign.chaptersCleared': chapters }
      : s.stats;
  // Chapter-clear exclusive card (CHARACTER_CARDS_DESIGN §4): a new chapter is cleared iff the finale-count
  // rose relative to the *prior* cleared set. Compare cleared arrays directly (robust to lazy/seeded stats,
  // which may lag). The finale just added is `levelId` → the newly cleared chapter is chapterOf(levelId).
  const newlyClearedChapter =
    chapters > chaptersClearedCount(s.progress.cleared) ? chapterOf(levelId) : undefined;
  return {
    next: {
      ...s,
      progress: { ...s.progress, cleared, stars: { ...s.progress.stars, [levelId]: stars2 } },
      ...(stats !== s.stats ? { stats } : {}),
    },
    newlyClearedChapter,
  };
}

/**
 * Pure computation shared by settleNormalClear and deliverVerifiedClearReward: apply a precomputed
 * material grant + reserve an equipmentInvCount slot for a precomputed equipment drop (silently skipped
 * when inventory is full). No I/O, no randomness — the equipment drop itself must be rolled with
 * Math.random() *before* entering mutateSave (a transform may run more than once on retry, which would
 * double-roll a synchronous dice inside it).
 */
function applyMaterialAndEquipmentGrant(
  s: SaveData,
  grant: Record<string, number>,
  pendingDrop: EquipmentInstance | undefined,
): { next: SaveData; dropGranted: boolean } {
  const materials = { ...s.materials };
  const everOwnedMaterial = new Set(s.everOwned?.material ?? []);
  for (const [m, n] of Object.entries(grant)) {
    materials[m] = (materials[m] ?? 0) + n;
    if (n > 0) everOwnedMaterial.add(m);
  }
  let next: SaveData = { ...s, materials, everOwned: { ...s.everOwned, material: [...everOwnedMaterial] } };
  let dropGranted = false;
  if (pendingDrop && s.equipmentInvCount < EQUIPMENT_INV_CAP) {
    const everOwnedEquip = new Set(next.everOwned?.equipment ?? []);
    everOwnedEquip.add(pendingDrop.defId);
    next = {
      ...next,
      equipmentInvCount: s.equipmentInvCount + 1,
      everOwned: { ...next.everOwned, equipment: [...everOwnedEquip] },
    };
    dropGranted = true;
  }
  return { next, dropGranted };
}

export function PveMixin<TBase extends MetaBaseCtor>(Base: TBase): TBase & Constructor<PveHandlers> {
  return class extends Base {
    /** Increment today's "material-rewarding clear" count by 1 (only claims a slot and returns true when below cap), same two-step pattern as bumpAdsCap. */
    private async bumpPveRewardCap(accountId: string, now: number): Promise<boolean> {
      const dayKey = new Date(now).toISOString().slice(0, 10);
      const id = `${accountId}:${dayKey}`;
      await this.deps.cols.pveDaily.updateOne(
        { _id: id },
        { $setOnInsert: { _id: id, accountId, dayKey, rewardedClears: 0, ts: now } },
        { upsert: true },
      );
      const res = await this.deps.cols.pveDaily.findOneAndUpdate(
        { _id: id, rewardedClears: { $lt: PVE_DAILY_CLEAR_REWARD_CAP } },
        { $inc: { rewardedClears: 1 }, $set: { ts: now } },
        { returnDocument: 'after' },
      );
      return !!res;
    }

    /**
     * Atomically deduct stamina: read pveStamina → apply natural regen → $inc with balance check.
     * Returns { ok: true, current } or { ok: false } (insufficient balance).
     */
    private async deductStamina(
      accountId: string,
      cost: number,
      now: number,
    ): Promise<{ ok: true; current: number; regenAt: number } | { ok: false }> {
      const { cols } = this.deps;
      const CAP = STAMINA_CAP;
      const REGEN_MS = STAMINA_REGEN_MS;

      // Lazily create the document (new account's first level entry).
      await cols.pveStamina.updateOne(
        { _id: accountId },
        { $setOnInsert: { _id: accountId, current: CAP, regenAt: 0 } },
        { upsert: true },
      );

      // Apply natural regen first (two-step: read → compute → write; a tiny concurrent window may grant 1 extra point, which is extremely unlikely and player-friendly).
      const stDoc = await cols.pveStamina.findOne({ _id: accountId });
      if (!stDoc) return { ok: false }; // theoretically unreachable (upsert already created it)

      let { current, regenAt } = stDoc;
      if (current < CAP && regenAt > 0 && now >= regenAt) {
        const ticks = Math.floor((now - regenAt) / REGEN_MS) + 1;
        current = Math.min(CAP, current + ticks);
        regenAt = current >= CAP ? 0 : regenAt + ticks * REGEN_MS;
        await cols.pveStamina.updateOne({ _id: accountId }, { $set: { current, regenAt } });
      }

      if (current < cost) return { ok: false };

      // Atomic deduction ($inc with $gte guard to prevent concurrent over-deduction).
      const newCurrent = current - cost;
      // Regen timer: if the deduction drops current below cap, start timing; if already counting, keep regenAt unchanged.
      const newRegenAt =
        regenAt !== 0
          ? regenAt
          : newCurrent < CAP
            ? now + REGEN_MS
            : 0;
      const res = await cols.pveStamina.findOneAndUpdate(
        { _id: accountId, current: { $gte: cost } },
        { $inc: { current: -cost }, $set: { regenAt: newRegenAt } },
        { returnDocument: 'after' },
      );
      if (!res) return { ok: false }; // lost concurrent race
      return { ok: true, current: res.current, regenAt: res.regenAt };
    }

    /**
     * PvE level entry (A4, 2026-07-06): stamina is deducted the moment the player commits to a level,
     * not at clear — retreating or losing mid-level does not refund it (pveClear no longer touches stamina).
     * Same unlock/ban validation as pveClear.
     */
    async pveEnter(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { cols, now } = this.deps;
      const { levelId } = req.body as { levelId: string };
      const level = findPveLevel(levelId);
      if (!level) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown level'));

      if (await this.rejectIfBanned(cols, accountId, reply)) return;
      const cur = await getOrCreateSave(cols, accountId, now());
      if (cur.antiCheat?.pveBanned) {
        return reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account banned'));
      }
      if (level.requires && !cur.progress.cleared.includes(level.requires)) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'level locked'));
      }

      const staminaCost = level.staminaCost ?? DEFAULT_STAMINA_COST;
      const staminaResult = await this.deductStamina(accountId, staminaCost, now());
      if (!staminaResult.ok) {
        return reply.code(402).send(err(ErrorCode.INSUFFICIENT_STAMINA, 'not enough stamina'));
      }
      return ok({ stamina: { current: staminaResult.current, regenAt: staminaResult.regenAt } });
    }

    /** Purchase stamina (deducts coins via commercial; 60 stamina = 30 coins, §A4). */
    async purchaseStamina(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { commercial, now: nowFn } = this.deps;
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
      const { cols } = this.deps;
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
     * Write progress/stars (unlock + record stars, taking the max), without touching materials.
     * Also detects a first chapter clear and reports it via `newlyClearedChapter` (the `ch{N}` id) so the
     * caller can grant the chapter-clear exclusive card (§4). Detection compares the chapter finale-count
     * of prior vs new cleared inside the same rev-guarded transaction, so it fires exactly once per chapter
     * (cleared is monotonic; a replay leaves cleared unchanged → no re-fire; a concurrent duplicate loses the
     * rev race and re-reads a cleared that already contains the finale → no double-fire).
     */
    private async writeClearProgress(
      accountId: string,
      levelId: string,
      stars: number,
    ): Promise<{ save: SaveData; newlyClearedChapter?: string } | { error: string }> {
      let newlyClearedChapter: string | undefined;
      const out = await this.mutateSave(accountId, (s) => {
        const r = applyClearProgress(s, levelId, stars);
        newlyClearedChapter = r.newlyClearedChapter;
        return r.next;
      });
      if ('error' in out) return out;
      return { save: out.save, newlyClearedChapter };
    }

    /**
     * Chapter-clear exclusive reward (CHARACTER_CARDS_DESIGN §4): grant a level-2 instance of the chapter's
     * anchor character card (§5.1 mapping) on the FIRST clear of that chapter's finale. Distinct from the
     * per-level drop (level 1, granted via settleNormalClear/deliverVerifiedClearReward) — this is a
     * one-time chapter reward, not farmable.
     * The caller invokes this only when {@link writeClearProgress} detected a new chapter clear, so it is
     * idempotent by construction (fires once per chapter). Roster-full → coin compensation, best-effort via
     * commercial (same path as gacha CC-5, economy.ts); the deterministic orderId also dedupes a retry.
     * Best-effort: a rev conflict here does not roll back the already-written chapter clear. Returns the
     * updated save when a card was granted (so the response can reflect it), else undefined.
     */
    private async grantChapterClearCard(accountId: string, chapterId: string): Promise<SaveData | undefined> {
      const cardId = chapterAnchorCard(chapterId);
      if (!cardId) return undefined;
      const def = CARD_DEFS[cardId];
      if (!def) return undefined;
      const { cols, now, commercial } = this.deps;
      const result = await grantCards(cols, now, accountId, [def], CHAPTER_ANCHOR_CARD_LEVEL);
      if ('error' in result) return undefined;
      if (result.compensatedCoins > 0 && commercial.available) {
        await commercial
          .grant({
            accountId,
            amount: result.compensatedCoins,
            reason: 'chapter_card_inv_full',
            orderId: `chapterCard:${accountId}:${chapterId}`,
          })
          .catch(() => { /* best-effort compensation; must not block the clear flow */ });
      }
      return result.save;
    }

    /**
     * Shared precompute for both settleNormalClear and deliverVerifiedClearReward: decide what's actually
     * grantable within the daily cap (CC-2), map the card drop to Hero Roster CardDefs, and roll the
     * equipment drop. Must run *before* entering any mutateSave transform: the daily-cap bump touches a
     * different collection (pveDaily) than the save, and the equipment roll uses Math.random() — a
     * mutateSave transform may run more than once on a rev conflict and must stay synchronous/deterministic.
     */
    private async prepareClearReward(
      accountId: string,
      levelId: string,
      reward: Record<string, number>,
    ): Promise<{
      capped: boolean;
      grant: Record<string, number>;
      cardGrant: Record<string, number>;
      defsToGrant: CardDef[];
      pendingDrop: EquipmentInstance | undefined;
    }> {
      const { now } = this.deps;
      const cardReward = levelCardReward(levelId);
      const hasReward = Object.keys(reward).length > 0 || Object.keys(cardReward).length > 0;
      const capped = hasReward ? !(await this.bumpPveRewardCap(accountId, now())) : false;
      const grant: Record<string, number> = capped ? {} : { ...reward };
      const cardGrant: Record<string, number> = capped ? {} : { ...cardReward };

      // Map card drop → CardDef for the new Hero Roster grant (CHARACTER_CARDS_DESIGN §4).
      // levelCardReward returns cardKeys (`${unitId}:${tier}`), so match CARD_DEFS by the unitId parsed
      // out of the key — not the whole key (a raw `infantry:1` never equals any CardDef.unitType `infantry`).
      // The drop tier in the key is informational only; Hero Roster instances are granted at a fixed level below.
      const defsToGrant: CardDef[] = [];
      for (const [key, count] of Object.entries(cardGrant)) {
        const unitId = parseCardKey(key)?.unitId;
        if (!unitId) continue;
        const def = Object.values(CARD_DEFS).find((d) => d.unitType === unitId);
        if (def) for (let i = 0; i < count; i++) defsToGrant.push(def);
      }

      // Equipment drop roll (independent of the daily cap; rolled outside mutateSave to avoid non-determinism from Math.random inside the transaction)
      const dropCfg = findPveLevel(levelId)?.equipmentDrop;
      const pendingDrop: EquipmentInstance | undefined =
        dropCfg && Math.random() < dropCfg.rate
          ? (makeDropInstance(dropCfg.rarity, `drop_${randomUUID()}`) as EquipmentInstance)
          : undefined;

      return { capped, grant, cardGrant, defsToGrant, pendingDrop };
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
    private async settleNormalClear(
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
      const { cols, now } = this.deps;
      const { capped, grant, cardGrant, defsToGrant, pendingDrop } =
        await this.prepareClearReward(accountId, levelId, reward);

      // PvE stat feed (S9-3b): passes through sanitizePvpReportedStats (L1 caps as a backstop against
      // "colluding with the judge to farm stats"; out-of-bounds data is discarded entirely, without blocking
      // material delivery). Empty/invalid input → no accrual.
      let cleanStats: Record<string, number> | undefined;
      if (clientStats) {
        const clean = sanitizePvpReportedStats(clientStats);
        if (clean && Object.keys(clean).length > 0) cleanStats = clean;
      }

      // ── One consolidated read-modify-write ──
      let newlyClearedChapter: string | undefined;
      let dropGranted = false;
      const out = await this.mutateSave(accountId, (s) => {
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

      // Card instance grant at level 1 (separate rev loop via the shared grantCards primitive; compensation
      // coins dropped — [DRAFT: wire commercial]). Level 1 matches every other card source (starters /
      // auction / gacha, §12); players raise cards via feeding, not the drop tier.
      let latestSave = out.save;
      if (defsToGrant.length > 0) {
        const cardResult = await grantCards(cols, now, accountId, defsToGrant);
        if ('error' in cardResult) return cardResult;
        latestSave = cardResult.save;
      }

      const grantedEquipment = dropGranted ? pendingDrop : undefined;
      return {
        save: latestSave,
        granted: grant,
        grantedCards: cardGrant,
        grantedEquipment,
        capped,
        newlyClearedChapter,
      };
    }

    /**
     * Consolidated post-verification reward delivery for the pveVerify (L1 spot-check) path — same
     * write-amplification fix as settleNormalClear, scoped to this caller's actual writes: material/
     * equipment grant + judged-stat accrual in one mutateSave. Progress/stars were already written at
     * spot-check submission time (writeClearProgress), and this path does not bump the daily retention
     * task or event task — that asymmetry (spot-checked clears don't count toward them) is pre-existing
     * behavior, unchanged by this consolidation. `statsJson` is the judge's re-simulation output (only
     * passed for a 'verified' verdict — pveVerify passes undefined for 'unverified' benefit-of-doubt
     * deliveries) and is parsed the same defensive way accrueJudgedPveStats used to.
     */
    private async deliverVerifiedClearReward(
      accountId: string,
      levelId: string,
      reward: Record<string, number>,
      statsJson: string | undefined,
    ): Promise<{
      save: SaveData;
      granted: Record<string, number>;
      grantedCards: Record<string, number>;
      grantedEquipment?: EquipmentInstance;
      capped: boolean;
    } | { error: string }> {
      const { cols, now } = this.deps;
      const { capped, grant, cardGrant, defsToGrant, pendingDrop } =
        await this.prepareClearReward(accountId, levelId, reward);

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

      let dropGranted = false;
      const out = await this.mutateSave(accountId, (s) => {
        const grantResult = applyMaterialAndEquipmentGrant(s, grant, pendingDrop);
        dropGranted = grantResult.dropGranted;
        let next = grantResult.next;
        if (cleanStats) {
          const stats = accrueStats(next.stats, cleanStats);
          if (stats !== next.stats) next = { ...next, stats };
        }
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

      let latestSave = out.save;
      if (defsToGrant.length > 0) {
        const cardResult = await grantCards(cols, now, accountId, defsToGrant);
        if ('error' in cardResult) return cardResult;
        latestSave = cardResult.save;
      }

      const grantedEquipment = dropGranted ? pendingDrop : undefined;
      return { save: latestSave, granted: grant, grantedCards: cardGrant, grantedEquipment, capped };
    }

    /**
     * PvE clear settlement: validate unlock → write progress/stars → deliver materials (within daily cap) → push back.
     * L1 spot-check (§8.6 step 3): if selected (first clear / blueprint anomaly / random) and a judge is available, **do not deliver materials yet**;
     * record a pveVerifications entry and respond with `needsReplay + verifyId` so the client can submit the replay to /pve/verify for re-simulation and credit.
     */
    async pveClear(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { cols, now, gateway } = this.deps;
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

      if (await this.rejectIfBanned(cols, accountId, reply)) return;
      const cur = await getOrCreateSave(cols, accountId, now());
      if (cur.antiCheat?.pveBanned) {
        return reply.code(403).send(err(ErrorCode.ACCOUNT_BANNED, 'account banned'));
      }
      // Prerequisite unlock check: the prerequisite level must already be cleared (newly offline-unlocked levels are rejected, §8 decision 4).
      if (level.requires && !cur.progress.cleared.includes(level.requires)) {
        return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'level locked'));
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
          const prog = await this.writeClearProgress(accountId, levelId, stars);
          if ('error' in prog) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, prog.error));
          // Chapter-clear exclusive card (§4): tied to the first-chapter-clear detection (same trigger as the
          // campaign.chaptersCleared stat, which is also written here on the spot-check path) — it is a one-time,
          // non-farmable reward, so it is granted alongside progress rather than deferred to /pve/verify (which
          // withholds only the farmable material reward). Delivered on this path so it fires exactly once.
          let progSave = prog.save;
          if (prog.newlyClearedChapter) {
            const s2 = await this.grantChapterClearCard(accountId, prog.newlyClearedChapter);
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
          const saveWithSt = { ...progSave, stamina: await this.readStaminaSnapshot(accountId, now()) };
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
      const granted = await this.settleNormalClear(accountId, levelId, stars, level.reward, clientStats);
      if ('error' in granted) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, granted.error));
      // Chapter-clear exclusive card (§4): fires once per chapter (first-clear detection), granted after the
      // consolidated write so its own re-read of the save reflects the level-2 anchor card in the response.
      let latestSave = granted.save;
      if (granted.newlyClearedChapter) {
        const s2 = await this.grantChapterClearCard(accountId, granted.newlyClearedChapter);
        if (s2) latestSave = s2;
      }
      // B6: record event task "pve.clear" (best-effort).
      accrueEventTask(cols, accountId, 'pve.clear', now()).catch(() => {});
      const saveWithSt = { ...latestSave, stamina: await this.readStaminaSnapshot(accountId, now()) };
      return ok({
        save: saveWithSt,
        granted: granted.granted,
        grantedCards: granted.grantedCards,
        ...(granted.grantedEquipment ? { grantedEquipment: granted.grantedEquipment } : {}),
        capped: granted.capped,
      });
    }

    /**
     * PvE L1 replay spot-check re-simulation (§8.6 step 3): client submits the replay frames of the flagged clear → dispatched via gateway to a third-party
     * online client for headless re-simulation (reuses S1-J, campaign mode + server-authoritative blueprint snapshot) → materials delivered only if re-simulated stars ≥ claimed.
     * If no judge is available (no candidates / timeout / re-simulation failure) → benefit-of-doubt: deliver anyway (honest players are not penalized for missing judges);
     * if re-simulated stars < claimed → flagged as suspicious, materials not delivered + recorded as rejected.
     */
    async pveVerify(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { cols, gateway, now } = this.deps;
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
      await cols.pveVerifications.updateOne(
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
          // A rejected doc is kept forever for ops review (mirrors MatchDoc.expireAt's disputed-match carve-out);
          // verified/unverified keep the expireAt set at insert.
          ...(rejected ? { $unset: { expireAt: '' as const } } : {}),
        },
      );

      if (rejected) {
        // No automatic ban (design decision, 2026-07-18): a rejection only means the re-simulation
        // yielded fewer stars than claimed, which can also happen to a legitimate, heavily-invested
        // account clearing early content passively (base/hero auto-attack alone, no card played that
        // tick) — see PVE_INTEGRITY_PLAN.md fairness note. Every rejection now files an ops review
        // ticket instead; a human decides whether to ban via the anti-cheat review queue.
        let rejectCount = 1;
        const saved = await this.mutateSave(accountId, (s) => {
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
        await insertSystemMail(this.deps.socialsvc ?? nullMetaSocialsvcClient, `pve-warn-${verifyId}`, accountId, {
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
      const granted = await this.deliverVerifiedClearReward(
        accountId,
        doc.levelId,
        level.reward,
        status === 'verified' ? verdict.statsJson : undefined,
      );
      if ('error' in granted) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, granted.error));
      return ok({
        save: granted.save,
        granted: granted.granted,
        grantedCards: granted.grantedCards,
        ...(granted.grantedEquipment ? { grantedEquipment: granted.grantedEquipment } : {}),
        capped: granted.capped,
        verified: true,
      });
    }

    /** PvE upgrade: server validates sufficient materials → deduct materials + increment pveUpgrades by 1 → push back (online only). */
    async pveUpgrade(req: FastifyRequest, reply: FastifyReply) {
      const accountId = accountIdOf(req);
      const { upgradeId } = req.body as { upgradeId: string };
      const def = findPveUpgrade(upgradeId);
      if (!def) return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'unknown upgrade'));

      const out = await this.mutateSave(accountId, (s) => {
        const lvl = s.pveUpgrades[upgradeId] ?? 0;
        const cost = pveUpgradeCost(def, lvl);
        if (!cost) return 'MAXED';
        if ((s.materials[cost.material] ?? 0) < cost.amount) return 'INSUFFICIENT';
        return {
          ...s,
          materials: { ...s.materials, [cost.material]: (s.materials[cost.material] ?? 0) - cost.amount },
          pveUpgrades: { ...s.pveUpgrades, [upgradeId]: lvl + 1 },
        };
      });
      if ('error' in out) {
        if (out.error === 'INSUFFICIENT') {
          return reply.code(402).send(err(ErrorCode.INSUFFICIENT_FUNDS, 'not enough materials'));
        }
        if (out.error === 'MAXED') {
          return reply.code(400).send(err(ErrorCode.BAD_REQUEST, 'upgrade maxed'));
        }
        return reply.code(409).send(err(ErrorCode.REV_CONFLICT, out.error));
      }
      return ok({ save: out.save });
    }
  };
}
