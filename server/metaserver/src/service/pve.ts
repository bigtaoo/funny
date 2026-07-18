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
  equipmentInvCount,
  accrueRetentionTask,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { grantCards } from '../cards.js';
import { insertSystemMail } from '../mail.js';
import { accrueEventTask } from '../events.js';
import { nullMetaSocialsvcClient } from '../socialsvcClient.js';
import type { MetaHandlers } from '../generated/routes.gen.js';
import { accountIdOf, STAMINA_CAP, STAMINA_REGEN_MS, type Constructor, type MetaBaseCtor } from './base.js';

type PveHandlers = Pick<MetaHandlers, 'purchaseStamina' | 'pveEnter' | 'pveClear' | 'pveVerify' | 'pveUpgrade'>;

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
      const spendRes = await commercial.spend({ accountId, amount: COST_COINS, reason: 'stamina_purchase', orderId });
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
        const cleared = s.progress.cleared.includes(levelId)
          ? s.progress.cleared
          : [...s.progress.cleared, levelId];
        const stars2 = Math.max(s.progress.stars[levelId] ?? 0, stars) as 1 | 2 | 3;
        // Achievement stat (S9-3, ACHIEVEMENT_DESIGN §4.2.2): accumulate campaign.chaptersCleared on first chapter clear,
        // in the same mutateSave transaction as progress (rev guard) — naturally authoritative and tamper-resistant. $max semantics → increments only on first clear, not on replays.
        // Lazy default creation: if no chapters cleared (count=0) and no existing stats, stats is not instantiated (saves storage).
        const chapters = chaptersClearedCount(cleared);
        const prevChapters = s.stats?.['campaign.chaptersCleared'] ?? 0;
        const stats =
          chapters > prevChapters
            ? { ...(s.stats ?? {}), 'campaign.chaptersCleared': chapters }
            : s.stats;
        // Chapter-clear exclusive card (CHARACTER_CARDS_DESIGN §4): a new chapter is cleared iff the finale-count
        // rose relative to the *prior* cleared set. Compare cleared arrays directly (robust to lazy/seeded stats,
        // which may lag). The finale just added is `levelId` → the newly cleared chapter is chapterOf(levelId).
        newlyClearedChapter =
          chapters > chaptersClearedCount(s.progress.cleared) ? chapterOf(levelId) : undefined;
        return {
          ...s,
          progress: { ...s.progress, cleared, stars: { ...s.progress.stars, [levelId]: stars2 } },
          ...(stats !== s.stats ? { stats } : {}),
        };
      });
      if ('error' in out) return out;
      return { save: out.save, newlyClearedChapter };
    }

    /**
     * Chapter-clear exclusive reward (CHARACTER_CARDS_DESIGN §4): grant a level-2 instance of the chapter's
     * anchor character card (§5.1 mapping) on the FIRST clear of that chapter's finale. Distinct from the
     * per-level drop (level 1, {@link grantClearReward}) — this is a one-time chapter reward, not farmable.
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
     * PvE stat feed (S9-3b): accumulate the in-match achievement counters (`kill.*`/`cast.*`) returned by the judge's re-simulation into the player's lifetime stats.
     * If statsJson fails to parse or is not an object → skip; passes through {@link sanitizePvpReportedStats} (L1 caps as a backstop against "colluding with the judge to farm stats";
     * out-of-bounds data is discarded entirely, without blocking material delivery); empty increments do not instantiate stats (lazy creation).
     * Errors are not thrown (stat feeding is a best-effort side effect and must never block the material delivery main path — the coin pool is small and one-time, §4.4).
     */
    private async accrueJudgedPveStats(accountId: string, statsJson: string | undefined): Promise<void> {
      if (!statsJson) return;
      let reported: Record<string, number>;
      try {
        const parsed = JSON.parse(statsJson) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        reported = parsed as Record<string, number>;
      } catch {
        return;
      }
      const clean = sanitizePvpReportedStats(reported);
      if (!clean || Object.keys(clean).length === 0) return; // L1 out-of-bounds rejected / nothing to accumulate
      await this.mutateSave(accountId, (s) => {
        const stats = accrueStats(s.stats, clean);
        return stats === s.stats ? s : { ...s, stats };
      });
    }

    /**
     * Deliver level rewards within the daily cap (material reward + card instance grants, CC-2).
     * Material reward is written atomically in a single mutateSave transaction.
     * Card rewards are mapped to CardDef instances and granted at level=2 via the async grantCards
     * (own rev loop, separate call). Equipment drop is rolled independently of the daily cap.
     * Returns actually delivered amounts (all empty if capped) + capped flag + save.
     */
    private async grantClearReward(
      accountId: string,
      levelId: string,
      reward: Record<string, number>,
    ): Promise<{
      save: SaveData;
      granted: Record<string, number>;
      grantedCards: Record<string, number>;
      grantedEquipment?: EquipmentInstance;
      capped: boolean;
    } | { error: string }> {
      const { cols, now } = this.deps;
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

      // Material reward + equipment drop (single atomic write)
      const out = await this.mutateSave(accountId, (s) => {
        const materials = { ...s.materials };
        for (const [m, n] of Object.entries(grant)) materials[m] = (materials[m] ?? 0) + n;
        let next = { ...s, materials };
        // Store equipment (silently skipped when inventory is full)
        if (pendingDrop && equipmentInvCount(next) < EQUIPMENT_INV_CAP) {
          next = { ...next, equipmentInv: { ...(next.equipmentInv ?? {}), [pendingDrop.id]: pendingDrop } };
        }
        return next;
      });
      if ('error' in out) return out;

      // Card instance grant at level 1 (separate rev loop; compensation coins dropped — [DRAFT: wire commercial]).
      // Level 1 matches every other card source (starters / auction / gacha, §12); players raise cards via feeding, not the drop tier.
      let latestSave = out.save;
      if (defsToGrant.length > 0) {
        const cardResult = await grantCards(cols, now, accountId, defsToGrant);
        if ('error' in cardResult) return cardResult;
        latestSave = cardResult.save;
      }

      // Confirm the drop was actually written (pendingDrop is not stored when inventory is full)
      const grantedEquipment =
        pendingDrop && latestSave.equipmentInv?.[pendingDrop.id] ? pendingDrop : undefined;
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
            pveUpgrades: { ...cur.pveUpgrades }, // legacy snapshot (kept for compatibility)
            unitLevels: {}, // unitLevels removed in CC-1 (SaveData v4); re-simulation uses cardInv
            reason,
            status: 'pending',
            // S9-3b: store client-reported counts as an audit comparison baseline (verdict.statsJson is the authoritative source; the reported field is for ops visibility only).
            ...(clientStats ? { reportedStats: clientStats } : {}),
            ts: now(),
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

      // Normal clear: write progress/stars then deliver materials + unit cards (within the daily cap, S12-C).
      const prog = await this.writeClearProgress(accountId, levelId, stars);
      if ('error' in prog) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, prog.error));
      // Chapter-clear exclusive card (§4), granted BEFORE grantClearReward so its subsequent re-read of the save
      // reflects the level-2 anchor card in the returned snapshot. Fires once per chapter (first-clear detection).
      if (prog.newlyClearedChapter) await this.grantChapterClearCard(accountId, prog.newlyClearedChapter);
      const granted = await this.grantClearReward(accountId, levelId, level.reward);
      if ('error' in granted) return reply.code(409).send(err(ErrorCode.REV_CONFLICT, granted.error));
      // S9-3b: non-spot-check path — accept client-reported stats, pass through L1 caps, then write to achievement counters.
      if (clientStats) await this.accrueJudgedPveStats(accountId, JSON.stringify(clientStats));
      // B5: record daily task "clear PvE" (idempotent, no-op if already recorded today).
      await this.bumpRetentionTask(accountId, 'pve.clear');
      // B6: record event task "pve.clear" (best-effort).
      accrueEventTask(cols, accountId, 'pve.clear', now()).catch(() => {});
      // Merge the retention update into the returned save so the client sees the task completion immediately after adoptServer.
      const nextRetention = accrueRetentionTask(granted.save.retention, 'pve.clear', now());
      const saveWithSt = {
        ...granted.save,
        ...(nextRetention !== granted.save.retention ? { retention: nextRetention } : {}),
        stamina: await this.readStaminaSnapshot(accountId, now()),
      };
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
        pveUpgrades: doc.pveUpgrades,
        ...(doc.unitLevels ? { unitLevels: doc.unitLevels } : {}),
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
        },
      );

      if (rejected) {
        let banned = false;
        let rejectCount = 1;
        const saved = await this.mutateSave(accountId, (s) => {
          const ac = s.antiCheat ?? { statSuspicion: 0 };
          rejectCount = (ac.pveRejectCount ?? 0) + 1;
          banned = rejectCount >= PVE_REJECT_BAN_THRESHOLD;
          return {
            ...s,
            antiCheat: {
              ...ac,
              pveRejectCount: rejectCount,
              lastFlaggedTs: now(),
              ...(banned ? { pveBanned: true } : {}),
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
          banned,
          ts: now(),
        });

        // C4: account-level pveWarnings count + warning mail + ban (intercepted at the auth layer).
        const updatedAcc = await cols.accounts.findOneAndUpdate(
          { _id: accountId },
          { $inc: { 'flags.pveWarnings': 1 } },
          { returnDocument: 'after', projection: { 'flags.pveWarnings': 1 } },
        );
        const newWarnings = updatedAcc?.flags?.pveWarnings ?? 1;
        if (newWarnings === 1) {
          // Best-effort: a failed warning mail must not block the reject-count/ban flow above.
          await insertSystemMail(this.deps.socialsvc ?? nullMetaSocialsvcClient, `pve-warn-${verifyId}`, accountId, {
            subject: 'Fair Play Warning',
            body: 'Unusual PvE activity was detected. Continued violations may result in account suspension.',
            expireDays: 30,
          }).catch((e) => req.log.warn({ err: e }, 'pve-warn mail failed'));
        }
        if (newWarnings >= PVE_REJECT_BAN_THRESHOLD) {
          await cols.accounts.updateOne({ _id: accountId }, { $set: { 'flags.banned': true } });
        }

        const s = 'error' in saved ? await getOrCreateSave(cols, accountId, now()) : saved.save;
        return ok({ save: s, granted: {}, capped: false, verified: false });
      }
      // PvE stat feed (S9-3b, ACHIEVEMENT_DESIGN §6.2): only when the **judge successfully re-simulated** (status==='verified', not benefit-of-doubt 'unverified'),
      // accumulate the judge-authoritative in-match kill/cast counts into lifetime stats.
      // The judge is a random third-party headless re-simulation → players cannot fabricate it; still passes through L1 caps as a cheap backstop against
      // "player colluding with the judge to farm stats" (out-of-bounds data discarded entirely, does not block material delivery). A2: counts are only written at this server-authoritative settlement point.
      if (status === 'verified') await this.accrueJudgedPveStats(accountId, verdict.statsJson);
      const granted = await this.grantClearReward(accountId, doc.levelId, level.reward);
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
