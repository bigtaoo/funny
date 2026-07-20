// Character card roster operations (CC-2, CHARACTER_CARDS_DESIGN §3/§4).
//
// grantCards: create CardInstances and add to save.cardInv; handles roster cap with coin
//             compensation (caller delivers coins via commercial if compensatedCoins > 0).
// fuseCards:  consume exactly FUSION_MATERIAL_COUNT material cards (same faction, same level
//             as the target) to raise the target one level; idempotencyKey prevents
//             double-consumption.
//
// Both functions use the optimistic-lock rev guard + retries pattern (same as equipment.ts).
// Shared pure math (applyFusion, FUSION_MATERIAL_COUNT) lives in @nw/shared/cards.
import { randomUUID } from 'node:crypto';
import {
  CARD_DEFS,
  CARD_INV_CAP,
  CARD_FULL_COMPENSATION_COINS,
  CARD_FEED_IDEM_TTL_SEC,
  CARD_INV_OVERFLOW_BUFFER,
  MAX_CARD_LEVEL,
  FUSION_MATERIAL_COUNT,
  cardInvCount,
  applyFusion,
  type Collections,
  type SaveData,
  type CardInstance,
  type CardDef,
} from '@nw/shared';
import { getOrCreateSave } from './save.js';
import { insertSystemMail } from './mail.js';
import type { MetaSocialsvcClient } from './socialsvcClient.js';

/** 30-day expiry, matching the auction/ladder-settlement system-mail convention. */
const CARD_OVERFLOW_MAIL_EXPIRE_DAYS = 30;

/** Context required to mail roster-full overflow cards instead of silently coin-compensating them (see grantCards). */
export interface CardMailCtx {
  socialsvc: MetaSocialsvcClient;
  /** Idempotency key for the system-mail upsert; scope it to the triggering order/request. */
  dispatchKey: string;
}

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
    const everOwnedHero = new Set(doc.save.everOwned?.hero ?? []);
    everOwnedHero.add(instance.defId);
    const next: SaveData = {
      ...doc.save,
      rev: doc.save.rev + 1,
      updatedAt: now(),
      cardInv: { ...(doc.save.cardInv ?? {}), [instance.id]: instance },
      everOwned: { ...doc.save.everOwned, hero: [...everOwnedHero] },
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
 * Each entry in `defs` produces one new CardInstance at `level` (default 1).
 * When the roster is full (≥ CARD_INV_CAP):
 *   - if `mailCtx` is given, the first CARD_INV_OVERFLOW_BUFFER overflow cards since the roster last had
 *     free space are mailed to the player as real instances (best-effort via socialsvc; counted by
 *     the persistent save.cardMailOverflowCount, reset to 0 the moment this call observes free room),
 *     and any remaining overflow beyond that falls back to coin compensation below.
 *   - without `mailCtx` (existing callers), overflow is coin-compensated as before — unchanged behavior.
 * compensatedCoins is caller-delivered via commercial if > 0.
 */
export async function grantCards(
  cols: Collections,
  now: () => number,
  accountId: string,
  defs: CardDef[],
  level = 1,
  mailCtx?: CardMailCtx,
): Promise<{ instances: CardInstance[]; mailedCount: number; compensatedCoins: number; save: SaveData } | CardError> {
  if (!defs.length) {
    const save = await getOrCreateSave(cols, accountId, now());
    return { instances: [], mailedCount: 0, compensatedCoins: 0, save };
  }

  // Pre-generate IDs outside the rev loop (same IDs on retry → $set is idempotent)
  const cardLevel = Math.max(1, Math.min(Math.floor(level), MAX_CARD_LEVEL));
  const pendingInstances = defs.map<CardInstance>((def) => ({
    id: `card_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    defId: def.id,
    level: cardLevel,
    gear: {},
    locked: false,
  }));

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;

    const newInstances: CardInstance[] = [];
    const mailInstances: CardInstance[] = [];
    let compensatedCoins = 0;
    let cap = cardInvCount(save.cardInv ?? {});
    // Free room right now → the mail quota refills; otherwise carry the persisted counter forward.
    let mailOverflowCount = mailCtx ? (cap < CARD_INV_CAP ? 0 : (save.cardMailOverflowCount ?? 0)) : 0;

    for (const inst of pendingInstances) {
      if (cap < CARD_INV_CAP) {
        newInstances.push(inst);
        cap++;
      } else if (mailCtx && mailOverflowCount < CARD_INV_OVERFLOW_BUFFER) {
        mailInstances.push(inst);
        mailOverflowCount++;
      } else {
        compensatedCoins += CARD_FULL_COMPENSATION_COINS;
      }
    }

    const nextCardInv = { ...(save.cardInv ?? {}) };
    for (const inst of newInstances) nextCardInv[inst.id] = inst;

    // Lifetime hero-owned ledger (avatar unlock): every def in this grant was obtained by the player,
    // regardless of whether the resulting instance landed in cardInv, was mailed, or was coin-compensated
    // for a full roster — the "obtained" event happened either way. Never pruned when cards are later
    // fused away (unlike cardInv), so an avatar picked from a since-consumed hero stays unlocked.
    const everOwnedHero = new Set(save.everOwned?.hero ?? []);
    for (const inst of pendingInstances) everOwnedHero.add(inst.defId);

    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      cardInv: nextCardInv,
      cardMailOverflowCount: mailCtx ? mailOverflowCount : save.cardMailOverflowCount,
      everOwned: { ...save.everOwned, hero: [...everOwnedHero] },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      if (mailInstances.length > 0 && mailCtx) {
        await insertSystemMail(mailCtx.socialsvc, mailCtx.dispatchKey, accountId, {
          subject: 'card.mail.rosterFull.subject',
          body: 'card.mail.rosterFull.body',
          attachments: mailInstances.map((instance) => ({ kind: 'card' as const, instance })),
          expireDays: CARD_OVERFLOW_MAIL_EXPIRE_DAYS,
        }).catch(() => { /* best-effort: same risk tolerance as the coin-compensation path below */ });
      }
      return { instances: newInstances, mailedCount: mailInstances.length, compensatedCoins, save: next };
    }
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/**
 * Toggle the lock flag on a single CardInstance (CC-4, CHARACTER_CARDS_DESIGN §3.3).
 * Locked cards cannot be consumed as fusion material (see fuseCards CARD_LOCKED guard).
 * Naturally idempotent: setting an already-matching flag still succeeds and returns the save.
 * Uses the optimistic-lock rev guard + retries pattern (same as fuseCards/grantCards).
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
 * Fuse material cards into a target card (CHARACTER_CARDS_DESIGN §3, fusion redesign).
 *
 * Rules:
 *   · Exactly FUSION_MATERIAL_COUNT material cards required, no more, no fewer (BAD_REQUEST otherwise).
 *   · Same faction only (tao→tao or anna→anna); cross-faction rejected with WRONG_FACTION.
 *   · Materials must be at the target's *current* level (checked before the level-up applies);
 *     mismatched-level materials rejected with BAD_REQUEST.
 *   · Material cards must not be locked; locked materials rejected with CARD_LOCKED.
 *   · Already at MAX_CARD_LEVEL: rejected with BAD_REQUEST (nothing to consume materials for).
 *   · All material cards are removed from cardInv atomically with the target's level bump.
 *
 * idempotencyKey prevents double-consumption: same key replays the fused card's state from
 * the first execution's target id (card may have been fused further since, so the *current*
 * card state is always returned, not a frozen snapshot).
 */
export async function fuseCards(
  cols: Collections,
  now: () => number,
  accountId: string,
  targetId: string,
  materialIds: string[],
  idempotencyKey: string,
): Promise<{ card: CardInstance; save: SaveData } | CardError> {
  if (!targetId) return { error: 'targetId required', code: 'BAD_REQUEST' };
  if (!Array.isArray(materialIds) || materialIds.length !== FUSION_MATERIAL_COUNT)
    return { error: `materialIds must contain exactly ${FUSION_MATERIAL_COUNT} entries`, code: 'BAD_REQUEST' };
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };
  if (materialIds.includes(targetId))
    return { error: 'target cannot be its own material', code: 'BAD_REQUEST' };
  const ids = [...new Set(materialIds)];
  if (ids.length !== FUSION_MATERIAL_COUNT)
    return { error: 'materialIds must not contain duplicates', code: 'BAD_REQUEST' };

  // Idempotency replay (materials already consumed; return current target card state)
  const replay = await cols.cardIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'fuse') {
    const save = await getOrCreateSave(cols, accountId, now());
    const card = save.cardInv?.[targetId];
    if (!card) return { error: 'target card not found', code: 'CARD_NOT_FOUND' };
    return { card, save };
  }

  // Pre-validation (friendly early error; authoritative re-check inside rev loop)
  const cur = await getOrCreateSave(cols, accountId, now());
  const curTarget = cur.cardInv?.[targetId];
  if (!curTarget) return { error: 'target card not found', code: 'CARD_NOT_FOUND' };
  const targetDef = CARD_DEFS[curTarget.defId];
  if (!targetDef) return { error: `unknown card def: ${curTarget.defId}`, code: 'BAD_REQUEST' };
  if (curTarget.level >= MAX_CARD_LEVEL)
    return { error: 'target card is already at max level', code: 'BAD_REQUEST' };

  const validateMaterials = (
    cardInv: Record<string, CardInstance>,
    target: CardInstance,
    tDef: CardDef,
  ): CardError | null => {
    for (const matId of ids) {
      const mat = cardInv[matId];
      if (!mat) return { error: `material card not found: ${matId}`, code: 'CARD_NOT_FOUND' };
      if (mat.locked) return { error: `material card is locked: ${matId}`, code: 'CARD_LOCKED' };
      const matDef = CARD_DEFS[mat.defId];
      if (!matDef) return { error: `unknown card def for material: ${matId}`, code: 'BAD_REQUEST' };
      if (matDef.faction !== tDef.faction) {
        return {
          error: `faction mismatch: target=${tDef.faction}, material=${matDef.faction} (${matId})`,
          code: 'WRONG_FACTION',
        };
      }
      if (mat.level !== target.level) {
        return {
          error: `material level mismatch: target=${target.level}, material=${mat.level} (${matId})`,
          code: 'BAD_REQUEST',
        };
      }
    }
    return null;
  };

  const preErr = validateMaterials(cur.cardInv ?? {}, curTarget, targetDef);
  if (preErr) return preErr;

  // Claim idempotency key (dup = concurrent retry → replay path)
  try {
    await cols.cardIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'fuse',
      result: { targetId },
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const save = await getOrCreateSave(cols, accountId, now());
      const card = save.cardInv?.[targetId];
      if (!card) return { error: 'target card not found', code: 'CARD_NOT_FOUND' };
      return { card, save };
    }
    throw e;
  }

  // Atomic write: remove materials + apply the level bump (optimistic-lock rev guard)
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
    if (target.level >= MAX_CARD_LEVEL) {
      await cols.cardIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'target card is already at max level', code: 'BAD_REQUEST' };
    }
    const err = validateMaterials(save.cardInv ?? {}, target, tDef);
    if (err) {
      await cols.cardIdem.deleteOne({ _id: idempotencyKey });
      return err;
    }

    const updatedTarget = applyFusion(target);

    const nextCardInv = { ...(save.cardInv ?? {}) };
    nextCardInv[targetId] = updatedTarget;
    for (const matId of ids) delete nextCardInv[matId];

    const next: SaveData = { ...save, rev: save.rev + 1, updatedAt: now(), cardInv: nextCardInv };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { card: updatedTarget, save: next };
  }

  await cols.cardIdem.deleteOne({ _id: idempotencyKey });
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}
