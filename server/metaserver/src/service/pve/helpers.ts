// PvE shared helpers (PVE_INTEGRITY_PLAN §8 + A4 stamina): pure transforms + the deps-only (no
// protected-base-method) pieces shared by the stamina/clear/verify domains. Split out of pve.ts
// (2026-08-10, 独立函数模块 form, equipment.ts's sibling — every function here takes its dependencies
// as explicit parameters rather than through a mixin's `this`, so pve.ts's own class body no longer
// needs to hold this logic at all). No behavior change.
import { randomUUID } from 'node:crypto';
import type { SaveData, CardDef, EquipmentInstance, RedisLike, Collections } from '@nw/shared';
import {
  findPveLevel,
  chaptersClearedCount,
  CARD_DEFS,
  chapterOf,
  chapterAnchorCard,
  CHAPTER_ANCHOR_CARD_LEVEL,
  levelCardReward,
  parseCardKey,
  makeDropInstance,
  EQUIPMENT_INV_CAP,
  bumpCappedCounter,
  PVE_DAILY_CLEAR_REWARD_CAP,
} from '@nw/shared';
import { grantCards } from '../../cards.js';
import type { CommercialClient } from '../../commercialClient.js';
import { STAMINA_CAP, STAMINA_REGEN_MS } from '../base.js';

/** Default stamina cost per level (A4, flat rate 2026-07-06): overridable per-level via PveLevelConfig.staminaCost. */
export const DEFAULT_STAMINA_COST = 10;

/** pveVerifications TTL (2026-07-27 audit finding: this collection had no expiry at all). Only applies to
 * verified/unverified outcomes — a `rejected` verdict unsets it (kept forever for ops review, like a
 * disputed match's MatchDoc.expireAt), since that's the small minority that actually carries replay frames. */
export const PVE_VERIFICATION_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** Author welcome mail dispatchKey (ONBOARDING_DESIGN §5.1): fixed key, `${dispatchKey}:${accountId}` is the
 *  idempotency pair (mail.ts insertSystemMail) so a client retry of pveClear never sends it twice. */
export const WELCOME_MAIL_DISPATCH_KEY = 'welcome.author';

/** Normalize the upgrade map (remove zero-value entries + sort keys) for stable cross-source comparison (L0 blueprint anomaly detection). */
export function normUpgrades(u: Record<string, number>): Record<string, number> {
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
export function applyClearProgress(
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
export function applyMaterialAndEquipmentGrant(
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

/** Increment today's "material-rewarding clear" count by 1 (only claims a slot and returns true when
 *  below cap). Redis-backed (2026-07-27, moved off Mongo's pveDaily — see shared/src/dailyCounter.ts). */
export async function bumpPveRewardCap(redis: RedisLike | null, accountId: string, now: number): Promise<boolean> {
  const dayKey = new Date(now).toISOString().slice(0, 10);
  return bumpCappedCounter(redis, 'pveDaily', accountId, dayKey, 'rewardedClears', PVE_DAILY_CLEAR_REWARD_CAP);
}

/**
 * Atomically deduct stamina: read pveStamina → apply natural regen → $inc with balance check.
 * Returns { ok: true, current } or { ok: false } (insufficient balance).
 */
export async function deductStamina(
  cols: Collections,
  accountId: string,
  cost: number,
  now: number,
): Promise<{ ok: true; current: number; regenAt: number } | { ok: false }> {
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
 * Chapter-clear exclusive reward (CHARACTER_CARDS_DESIGN §4): grant a level-2 instance of the chapter's
 * anchor character card (§5.1 mapping) on the FIRST clear of that chapter's finale. Distinct from the
 * per-level drop (level 1, granted via settleNormalClear/deliverVerifiedClearReward) — this is a
 * one-time chapter reward, not farmable.
 * The caller invokes this only when {@link applyClearProgress} detected a new chapter clear, so it is
 * idempotent by construction (fires once per chapter). Roster-full → coin compensation, best-effort via
 * commercial (same path as gacha CC-5, economy.ts); the deterministic orderId also dedupes a retry.
 * Best-effort: a rev conflict here does not roll back the already-written chapter clear. Returns the
 * updated save when a card was granted (so the response can reflect it), else undefined.
 */
export async function grantChapterClearCard(
  cols: Collections,
  now: () => number,
  commercial: CommercialClient,
  accountId: string,
  chapterId: string,
): Promise<SaveData | undefined> {
  const cardId = chapterAnchorCard(chapterId);
  if (!cardId) return undefined;
  const def = CARD_DEFS[cardId];
  if (!def) return undefined;
  const result = await grantCards(cols, now, accountId, [def], `pve_anchor:${chapterId}`, CHAPTER_ANCHOR_CARD_LEVEL);
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
export async function prepareClearReward(
  redis: RedisLike | null,
  now: number,
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
  const cardReward = levelCardReward(levelId);
  const hasReward = Object.keys(reward).length > 0 || Object.keys(cardReward).length > 0;
  const capped = hasReward ? !(await bumpPveRewardCap(redis, accountId, now)) : false;
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
      ? (makeDropInstance(dropCfg.rarity, `drop_${randomUUID()}`, `pve_drop:${levelId}`, now) as EquipmentInstance)
      : undefined;

  return { capped, grant, cardGrant, defsToGrant, pendingDrop };
}
