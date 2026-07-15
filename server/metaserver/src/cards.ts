// Character card roster operations (CC-2, CHARACTER_CARDS_DESIGN §3/§4).
//
// grantCards: create CardInstances and add to save.cardInv; handles roster cap with coin
//             compensation (caller delivers coins via commercial if compensatedCoins > 0).
// feedCards:  consume material cards to gain XP, level-up with overflow carry; same-faction
//             required; locked materials rejected; idempotencyKey prevents double-consumption.
//             Per-material XP transfer is feedXp(material) itself (efficiency loss for level 2+
//             material is baked into feedXp; level 1 material feeds its full value, no loss).
//
// Both functions use the optimistic-lock rev guard + retries pattern (same as equipment.ts).
// Shared pure math (feedXp, LEVEL_CUMULATIVE_XP) lives in @nw/shared/cards.
import { randomUUID } from 'node:crypto';
import {
  CARD_DEFS,
  CARD_INV_CAP,
  CARD_FULL_COMPENSATION_COINS,
  CARD_FEED_IDEM_TTL_SEC,
  cardInvCount,
  feedXp,
  LEVEL_CUMULATIVE_XP,
  type Collections,
  type SaveData,
  type CardInstance,
  type CardDef,
} from '@nw/shared';
import { getOrCreateSave } from './save.js';

export type CardErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'CARD_NOT_FOUND'
  | 'WRONG_FACTION'
  | 'CARD_LOCKED'
  | 'REV_CONFLICT';

export interface CardError {
  error: string;
  code: CardErrorCode;
}

const REV_RETRIES = 3;

function idemExpireAt(now: number): Date {
  return new Date(now + CARD_FEED_IDEM_TTL_SEC * 1000);
}

/**
 * Pure XP application: adds `gainedXp` to `card.xp`, leveling up as many times as possible.
 * Overflow XP carries into the next level; at level 9 remaining XP is discarded.
 */
function applyFeedXp(card: CardInstance, gainedXp: number): { card: CardInstance; levelsGained: number } {
  let { level, xp } = card;
  xp += gainedXp;
  let levelsGained = 0;
  while (level < 9) {
    const curCum = LEVEL_CUMULATIVE_XP[level];
    const nextCum = LEVEL_CUMULATIVE_XP[level + 1];
    if (curCum === undefined || nextCum === undefined) break;
    const cost = nextCum - curCum;
    if (xp < cost) break;
    xp -= cost;
    level++;
    levelsGained++;
  }
  if (level >= 9) xp = 0; // max level: discard overflow
  return { card: { ...card, level, xp }, levelsGained };
}

/**
 * Write a full card instance snapshot into save.cardInv (auction escrow-out: sale delivery to buyer /
 * cancellation·expiry·season-end return to seller, and mail-attachment claim).
 * Overwrites by instance.id → naturally idempotent (re-delivering the same instance does not duplicate it);
 * no roster-cap check (a card returned from escrow or bought is always delivered — the buyer paid for it).
 * Mirrors equipment.ts grantEquipment.
 */
export async function grantCard(
  cols: Collections,
  now: () => number,
  accountId: string,
  instance: CardInstance,
): Promise<{ ok: true } | CardError> {
  if (!instance?.id) return { error: 'instance required', code: 'BAD_REQUEST' };
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const next: SaveData = {
      ...doc.save,
      rev: doc.save.rev + 1,
      updatedAt: now(),
      cardInv: { ...(doc.save.cardInv ?? {}), [instance.id]: instance },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { ok: true };
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/**
 * Create card instances and add them to save.cardInv (CHARACTER_CARDS_DESIGN §4).
 * Each entry in `defs` produces one new CardInstance at `level` (default 1), xp=0.
 * When the roster is full (≥ CARD_INV_CAP), the card is not added and compensatedCoins is
 * incremented by CARD_FULL_COMPENSATION_COINS (caller must deliver via commercial if > 0).
 */
export async function grantCards(
  cols: Collections,
  now: () => number,
  accountId: string,
  defs: CardDef[],
  level = 1,
): Promise<{ instances: CardInstance[]; compensatedCoins: number; save: SaveData } | CardError> {
  if (!defs.length) {
    const save = await getOrCreateSave(cols, accountId, now());
    return { instances: [], compensatedCoins: 0, save };
  }

  // Pre-generate IDs outside the rev loop (same IDs on retry → $set is idempotent)
  const cardLevel = Math.max(1, Math.min(Math.floor(level), 9));
  const pendingInstances = defs.map<CardInstance>((def) => ({
    id: `card_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    defId: def.id,
    level: cardLevel,
    xp: 0,
    gear: {},
    locked: false,
  }));

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;

    const newInstances: CardInstance[] = [];
    let compensatedCoins = 0;
    let cap = cardInvCount(save.cardInv ?? {});

    for (const inst of pendingInstances) {
      if (cap < CARD_INV_CAP) {
        newInstances.push(inst);
        cap++;
      } else {
        compensatedCoins += CARD_FULL_COMPENSATION_COINS;
      }
    }

    const nextCardInv = { ...(save.cardInv ?? {}) };
    for (const inst of newInstances) nextCardInv[inst.id] = inst;

    const next: SaveData = { ...save, rev: save.rev + 1, updatedAt: now(), cardInv: nextCardInv };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { instances: newInstances, compensatedCoins, save: next };
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/**
 * Toggle the lock flag on a single CardInstance (CC-4, CHARACTER_CARDS_DESIGN §3.3).
 * Locked cards cannot be consumed as feed material (see feedCards CARD_LOCKED guard).
 * Naturally idempotent: setting an already-matching flag still succeeds and returns the save.
 * Uses the optimistic-lock rev guard + retries pattern (same as feedCards/grantCards).
 */
export async function setCardLock(
  cols: Collections,
  now: () => number,
  accountId: string,
  cardInstanceId: string,
  locked: boolean,
): Promise<{ save: SaveData } | CardError> {
  if (!cardInstanceId) return { error: 'cardInstanceId required', code: 'BAD_REQUEST' };
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;
    const card = save.cardInv?.[cardInstanceId];
    if (!card) return { error: `card not found: ${cardInstanceId}`, code: 'CARD_NOT_FOUND' };

    // No-op when already in the requested state (avoids a needless rev bump).
    if (card.locked === locked) return { save };

    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      cardInv: { ...(save.cardInv ?? {}), [cardInstanceId]: { ...card, locked } },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { save: next };
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/**
 * Feed material cards into a target card (CHARACTER_CARDS_DESIGN §3.3).
 *
 * Rules:
 *   · Same faction only (tao→tao or anna→anna); cross-faction rejected with WRONG_FACTION.
 *   · Material cards must not be locked; locked materials rejected with CARD_LOCKED.
 *   · XP transferred per material = feedXp(material) (level 1 feeds full value; level 2+ at 80%).
 *   · Level-up is computed in a loop; overflow XP carries forward; max level is 9.
 *   · All material cards are removed from cardInv atomically with the XP write.
 *
 * idempotencyKey prevents double-consumption: same key replays levelsGained from first
 * execution + returns current card state (card may have been fed further since).
 */
export async function feedCards(
  cols: Collections,
  now: () => number,
  accountId: string,
  targetId: string,
  materialIds: string[],
  idempotencyKey: string,
): Promise<{ card: CardInstance; levelsGained: number; save: SaveData } | CardError> {
  if (!targetId) return { error: 'targetId required', code: 'BAD_REQUEST' };
  if (!Array.isArray(materialIds) || materialIds.length === 0)
    return { error: 'materialIds must be a non-empty array', code: 'BAD_REQUEST' };
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };
  if (materialIds.includes(targetId))
    return { error: 'target cannot be its own material', code: 'BAD_REQUEST' };

  // Idempotency replay (materials already consumed; return stored levelsGained + current card)
  const replay = await cols.cardIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'feed') {
    const save = await getOrCreateSave(cols, accountId, now());
    const card = save.cardInv?.[targetId];
    if (!card) return { error: 'target card not found', code: 'CARD_NOT_FOUND' };
    return { card, levelsGained: (replay.result as { levelsGained: number }).levelsGained, save };
  }

  const ids = [...new Set(materialIds)]; // deduplicate

  // Pre-validation (friendly early error; authoritative re-check inside rev loop)
  const cur = await getOrCreateSave(cols, accountId, now());
  const curTarget = cur.cardInv?.[targetId];
  if (!curTarget) return { error: 'target card not found', code: 'CARD_NOT_FOUND' };
  const targetDef = CARD_DEFS[curTarget.defId];
  if (!targetDef) return { error: `unknown card def: ${curTarget.defId}`, code: 'BAD_REQUEST' };

  for (const matId of ids) {
    const mat = cur.cardInv?.[matId];
    if (!mat) return { error: `material card not found: ${matId}`, code: 'CARD_NOT_FOUND' };
    if (mat.locked) return { error: `material card is locked: ${matId}`, code: 'CARD_LOCKED' };
    const matDef = CARD_DEFS[mat.defId];
    if (!matDef) return { error: `unknown card def for material: ${matId}`, code: 'BAD_REQUEST' };
    if (matDef.faction !== targetDef.faction) {
      return {
        error: `faction mismatch: target=${targetDef.faction}, material=${matDef.faction} (${matId})`,
        code: 'WRONG_FACTION',
      };
    }
  }

  // Pre-compute levelsGained for idem doc (from current save; may differ from actual if concurrent feed)
  let previewXp = 0;
  for (const matId of ids) previewXp += feedXp(cur.cardInv![matId]!);
  const { levelsGained: previewLevels } = applyFeedXp(curTarget, previewXp);

  // Claim idempotency key (dup = concurrent retry → replay path)
  try {
    await cols.cardIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'feed',
      result: { targetId, levelsGained: previewLevels },
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.cardIdem.findOne({ _id: idempotencyKey });
      const save = await getOrCreateSave(cols, accountId, now());
      const card = save.cardInv?.[targetId];
      if (!card) return { error: 'target card not found', code: 'CARD_NOT_FOUND' };
      return { card, levelsGained: (prev?.result as { levelsGained: number })?.levelsGained ?? 0, save };
    }
    throw e;
  }

  // Atomic write: remove materials + apply XP + level-up (optimistic-lock rev guard)
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      await cols.cardIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    const save = doc.save;

    // Re-validate inside rev loop (concurrent material consumption possible)
    const target = save.cardInv?.[targetId];
    if (!target) {
      await cols.cardIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'target card not found', code: 'CARD_NOT_FOUND' };
    }
    const tDef = CARD_DEFS[target.defId];
    if (!tDef) {
      await cols.cardIdem.deleteOne({ _id: idempotencyKey });
      return { error: `unknown card def: ${target.defId}`, code: 'BAD_REQUEST' };
    }

    let gainedXp = 0;
    for (const matId of ids) {
      const mat = save.cardInv?.[matId];
      if (!mat) {
        await cols.cardIdem.deleteOne({ _id: idempotencyKey });
        return { error: `material card not found: ${matId}`, code: 'CARD_NOT_FOUND' };
      }
      if (mat.locked) {
        await cols.cardIdem.deleteOne({ _id: idempotencyKey });
        return { error: `material card is locked: ${matId}`, code: 'CARD_LOCKED' };
      }
      const mDef = CARD_DEFS[mat.defId];
      if (!mDef || mDef.faction !== tDef.faction) {
        await cols.cardIdem.deleteOne({ _id: idempotencyKey });
        return { error: `faction mismatch for material: ${matId}`, code: 'WRONG_FACTION' };
      }
      gainedXp += feedXp(mat);
    }

    const { card: updatedTarget, levelsGained } = applyFeedXp(target, gainedXp);

    const nextCardInv = { ...(save.cardInv ?? {}) };
    nextCardInv[targetId] = updatedTarget;
    for (const matId of ids) delete nextCardInv[matId];

    const next: SaveData = { ...save, rev: save.rev + 1, updatedAt: now(), cardInv: nextCardInv };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // Update idem doc with actual levelsGained (best-effort; replay returns accurate value)
      void cols.cardIdem.updateOne(
        { _id: idempotencyKey },
        { $set: { 'result.levelsGained': levelsGained } },
      );
      return { card: updatedTarget, levelsGained, save: next };
    }
  }

  await cols.cardIdem.deleteOne({ _id: idempotencyKey });
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}
