// Character card roster operations (CC-2, CHARACTER_CARDS_DESIGN §3/§4).
//
// Storage (2026-07-27, perf, mirrors the equipmentInv split of 2026-07-26 — see equipment.ts header):
// instances live in the `cardInstances` collection (_id=instanceId), NOT embedded in SaveData.cardInv
// anymore — an embedded map of up to 500 cards was a second unbounded contributor to save-doc bloat on
// Atlas M0. `save` only carries a `cardInvCount` mirror for cheap cap checks. GET /save and
// /internal/save-fields still reassemble the full `cardInv` map on demand (`assembleCardInv`).
//
// No Mongo transactions in this codebase (see shared/src/mongo.ts header) — cross-collection consistency
// here relies on ordering discipline + idempotency, same house style as equipment.ts.
//
// grantCard:   worldsvc auction trade transfer / listing cancellation·expiry·season-end return / mail
//              claim: writes a full instance snapshot (mirrors equipment.ts grantEquipment).
// grantCards:  create CardInstances; handles roster cap with mail/coin-compensation overflow (caller
//              delivers coins via commercial if compensatedCoins > 0).
// setCardLock: toggle the lock flag on one card (mirrors no other collections).
// fuseCards:   consume exactly FUSION_MATERIAL_COUNT material cards (same faction, same level as the
//              target) to raise the target one level; idempotencyKey prevents double-consumption.
// escrowCard:  worldsvc auction escrow: validate gear all empty → remove from cardInstances → return
//              snapshot (mirrors equipment.ts escrowEquipment).
//
// grantCards/setCardLock/fuseCards/escrowCard use the optimistic-lock rev guard + retries pattern (same as equipment.ts).
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
  applyFusion,
  type Collections,
  type SaveData,
  type CardInstance,
  type CardInstanceDoc,
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
  | 'CARD_HAS_GEAR'
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

export function toCardDoc(instance: CardInstance, accountId: string): CardInstanceDoc {
  return {
    _id: instance.id,
    accountId,
    defId: instance.defId,
    level: instance.level,
    gear: instance.gear,
    locked: instance.locked,
  };
}

function fromCardDoc(doc: CardInstanceDoc): CardInstance {
  return {
    id: doc._id,
    defId: doc.defId,
    level: doc.level,
    gear: doc.gear,
    locked: doc.locked,
  };
}

/**
 * Reassembles the full cardInv map from `cardInstances`, for wire-format compatibility (every player-facing
 * response shape is unchanged by the storage split). Also opportunistically self-heals `cardInvCount` drift
 * (a plain field $set, no rev guard — it's an informational mirror never used as a lock, so this can never
 * spuriously conflict with a real optimistic-lock write) since this call already has the true count in hand.
 */
export async function assembleCardInv(
  cols: Collections,
  accountId: string,
  save?: SaveData,
): Promise<Record<string, CardInstance>> {
  const docs = await cols.cardInstances.find({ accountId }).toArray();
  const inv: Record<string, CardInstance> = {};
  for (const doc of docs) inv[doc._id] = fromCardDoc(doc);
  if (save && save.cardInvCount !== docs.length) {
    await cols.saves.updateOne({ _id: accountId }, { $set: { 'save.cardInvCount': docs.length } });
  }
  return inv;
}

/**
 * Narrow variant of `assembleCardInv`: resolves only the given instance ids, still scoped to
 * `accountId` (a foreign or sold id simply doesn't come back, which is exactly the "do you still own
 * this?" answer callers want). Added 2026-08-02 for worldsvc's `getTeams` self-heal, which sits on
 * the CityScene critical path and only ever needs to validate the ≤ 5×12 ids its formations
 * reference — pulling a 500-card roster for that was the dominant cost of GET /world/teams.
 *
 * Deliberately skips assembleCardInv's opportunistic `cardInvCount` self-heal: a filtered `find` has
 * no view of the true roster size, so writing `docs.length` here would actively corrupt the mirror.
 */
export async function assembleCardInvSubset(
  cols: Collections,
  accountId: string,
  ids: readonly string[],
): Promise<Record<string, CardInstance>> {
  if (ids.length === 0) return {};
  const docs = await cols.cardInstances.find({ accountId, _id: { $in: [...ids] } }).toArray();
  const inv: Record<string, CardInstance> = {};
  for (const doc of docs) inv[doc._id] = fromCardDoc(doc);
  return inv;
}

/**
 * Write a full card instance snapshot into `cardInstances` (auction escrow-out: sale delivery to buyer /
 * cancellation·expiry·season-end return to seller, and mail-attachment claim).
 * Idempotent by instance.id: if this exact instance already exists for this account, a prior call already
 * completed (including the count increment) — replay without double-incrementing. Mirrors equipment.ts grantEquipment.
 * No roster-cap check (a card returned from escrow or bought is always delivered — the buyer paid for it).
 */
export async function grantCard(
  cols: Collections,
  now: () => number,
  accountId: string,
  instance: CardInstance,
): Promise<{ ok: true } | CardError> {
  if (!instance?.id) return { error: 'instance required', code: 'BAD_REQUEST' };

  const already = await cols.cardInstances.findOne({ _id: instance.id, accountId });
  await cols.cardInstances.updateOne(
    { _id: instance.id },
    { $set: toCardDoc(instance, accountId) },
    { upsert: true },
  );
  if (already) return { ok: true };

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const everOwnedHero = new Set(doc.save.everOwned?.hero ?? []);
    everOwnedHero.add(instance.defId);
    const next: SaveData = {
      ...doc.save,
      rev: doc.save.rev + 1,
      updatedAt: now(),
      cardInvCount: doc.save.cardInvCount + 1,
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
 * Create card instances (CHARACTER_CARDS_DESIGN §4).
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

  // Pre-generate IDs outside the rev loop (same IDs on retry → the eventual instance upsert is idempotent).
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
    let cap = save.cardInvCount;
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
      cardInvCount: cap,
      cardMailOverflowCount: mailCtx ? mailOverflowCount : save.cardMailOverflowCount,
      everOwned: { ...save.everOwned, hero: [...everOwnedHero] },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // Save side (count/mail-quota/everOwned) committed FIRST — this attempt's classification has won
      // and cannot be reclassified by a later retry, so it's now safe to persist the actual instances
      // (an earlier retry attempt's classification, if any, was discarded before ever touching
      // cardInstances). A crash in this narrow window leaves cardInvCount ahead of the true
      // cardInstances count (self-heals downward via assembleCardInv's join on the next read; same
      // accepted tradeoff as equipment.ts's craftEquipment).
      for (const inst of newInstances) {
        await cols.cardInstances.updateOne(
          { _id: inst.id },
          { $set: toCardDoc(inst, accountId) },
          { upsert: true },
        );
      }
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
 * Naturally idempotent: setting an already-matching flag still succeeds and returns the save without
 * bumping rev (no-op — `save` doesn't change at all now that `locked` lives on the cardInstances doc).
 * The `cardInstances` write commits first (mirrors equipment.ts's ordering discipline for a
 * destructive/state-changing op), then the save-side rev bump — a crash between the two leaves the lock
 * applied but the client's rev stale by one, self-correcting on the next real save write.
 */
export async function setCardLock(
  cols: Collections,
  now: () => number,
  accountId: string,
  cardInstanceId: string,
  locked: boolean,
): Promise<{ save: SaveData } | CardError> {
  if (!cardInstanceId) return { error: 'cardInstanceId required', code: 'BAD_REQUEST' };
  const cardDoc = await cols.cardInstances.findOne({ _id: cardInstanceId, accountId });
  if (!cardDoc) return { error: `card not found: ${cardInstanceId}`, code: 'CARD_NOT_FOUND' };

  if (cardDoc.locked === locked) return { save: await getOrCreateSave(cols, accountId, now()) };

  await cols.cardInstances.updateOne({ _id: cardInstanceId, accountId }, { $set: { locked } });

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const next: SaveData = { ...doc.save, rev: doc.save.rev + 1, updatedAt: now() };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { save: next };
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/**
 * worldsvc auction escrow: removes one card instance from the seller's inventory and returns a snapshot
 * (worldsvc stores it in the listing doc). Card must not have any gear equipped (§11 rule: unequip before
 * listing). Mirrors equipment.ts escrowEquipment, including its idempotency ledger (2026-08-03 fix: this
 * endpoint previously accepted orderId but never used it to dedupe — a retry after a lost HTTP response
 * would find the instance already deleted and return CARD_NOT_FOUND, permanently losing the card with no
 * listing ever created).
 */
export async function escrowCard(
  cols: Collections,
  now: () => number,
  accountId: string,
  instanceId: string,
  orderId: string,
): Promise<{ instance: CardInstance } | CardError> {
  if (!instanceId || !orderId) return { error: 'instanceId + orderId required', code: 'BAD_REQUEST' };

  const existing = await cols.cardIdem.findOne({ _id: orderId });
  if (existing?.op === 'escrow') return { instance: existing.result as CardInstance };

  const [saveDoc, cardDoc] = await Promise.all([
    cols.saves.findOne({ _id: accountId }),
    cols.cardInstances.findOne({ _id: instanceId, accountId }),
  ]);
  if (!saveDoc) return { error: 'save not found', code: 'NOT_FOUND' };
  if (!cardDoc) {
    // Concurrently escrowed (idem already written) → replay; otherwise the card genuinely does not exist.
    const replay = await cols.cardIdem.findOne({ _id: orderId });
    if (replay?.op === 'escrow') return { instance: replay.result as CardInstance };
    return { error: 'card not found', code: 'CARD_NOT_FOUND' };
  }
  const card = fromCardDoc(cardDoc);
  if (Object.values(card.gear).some((v) => !!v)) {
    return { error: 'card has equipped gear; unequip before listing', code: 'CARD_HAS_GEAR' };
  }

  // Destructive op up front (idempotent delete — safe even if the saves-side rev-guard below has to loop
  // on a concurrent write to this account's save), mirrors equipment.ts escrowEquipment. Scoped to
  // accountId too, closing a narrow cross-account TOCTOU window versus the validating read above.
  await cols.cardInstances.deleteOne({ _id: instanceId, accountId });

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const next: SaveData = {
      ...doc.save,
      rev: doc.save.rev + 1,
      updatedAt: now(),
      cardInvCount: Math.max(0, doc.save.cardInvCount - 1),
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // Record ledger entry after the save write lands ($setOnInsert prevents a concurrent duplicate
      // write from clobbering the first result).
      await cols.cardIdem.updateOne(
        { _id: orderId },
        { $setOnInsert: { accountId, op: 'escrow', result: card, expireAt: idemExpireAt(now()) } },
        { upsert: true },
      );
      return { instance: card };
    }
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
 *   · All material cards are removed from cardInstances atomically with the target's level bump.
 *
 * idempotencyKey prevents double-consumption: same key replays the fused card's *current* stored state
 * (no verify-and-heal recompute — same behavior as before the storage split: the ledger only marks that a
 * fuse with this key happened, it doesn't record/replay a computed result).
 *
 * Validated ONCE, then committed ONCE (mirrors equipment.ts reforgeEquipment, not the read-modify-retry
 * loop equipment.ts's craft/enhance/salvage use) — the destructive two-document effect (target upgrade +
 * 5 materials consumed) can't be safely re-attempted against a partially-mutated batch on a later retry
 * (re-reading after a partial delete would find missing materials and wrongly reject an already-completed
 * fusion). The target update is guarded by a `level` match (fine-grained optimistic lock on just that
 * document, same technique as equipment.ts enhanceEquipment) so a concurrent second fuse attempt on the
 * same target can't silently clobber this one's result. Only the saves-side count-mirror decrement is
 * retried (rev-guarded), matching equipment.ts reforgeEquipment's structure.
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

  // Idempotency replay (materials already consumed; return current target card state).
  const replay = await cols.cardIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'fuse') {
    const [save, targetDoc] = await Promise.all([
      getOrCreateSave(cols, accountId, now()),
      cols.cardInstances.findOne({ _id: targetId, accountId }),
    ]);
    if (!targetDoc) return { error: 'target card not found', code: 'CARD_NOT_FOUND' };
    return { card: fromCardDoc(targetDoc), save };
  }

  // Pre-validation, checked ONCE (not re-validated after this point — see the function doc comment).
  const [cur, curDocs] = await Promise.all([
    getOrCreateSave(cols, accountId, now()),
    cols.cardInstances.find({ _id: { $in: [targetId, ...ids] }, accountId }).toArray(),
  ]);
  const curMap = new Map(curDocs.map((d) => [d._id, fromCardDoc(d)]));
  const curTarget = curMap.get(targetId);
  if (!curTarget) return { error: 'target card not found', code: 'CARD_NOT_FOUND' };
  const targetDef = CARD_DEFS[curTarget.defId];
  if (!targetDef) return { error: `unknown card def: ${curTarget.defId}`, code: 'BAD_REQUEST' };
  if (curTarget.level >= MAX_CARD_LEVEL)
    return { error: 'target card is already at max level', code: 'BAD_REQUEST' };

  const validateMaterials = (
    cardMap: Map<string, CardInstance>,
    target: CardInstance,
    tDef: CardDef,
  ): CardError | null => {
    for (const matId of ids) {
      const mat = cardMap.get(matId);
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

  const preErr = validateMaterials(curMap, curTarget, targetDef);
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
      const [save, targetDoc] = await Promise.all([
        getOrCreateSave(cols, accountId, now()),
        cols.cardInstances.findOne({ _id: targetId, accountId }),
      ]);
      if (!targetDoc) return { error: 'target card not found', code: 'CARD_NOT_FOUND' };
      return { card: fromCardDoc(targetDoc), save };
    }
    throw e;
  }

  const updatedTarget = applyFusion(curTarget);

  // Two-document effect (target upgrade + 5 materials consumed) can't be one atomic write without a
  // transaction (see shared/src/mongo.ts header). Target first, guarded by `level` matching the
  // pre-validated value (fine-grained optimistic lock — same technique as equipment.ts enhanceEquipment):
  // if a concurrent fuse already changed this target since the check above, matchedCount is 0 and we bail
  // out with REV_CONFLICT *before* touching any material, so nothing is destroyed for a fusion that didn't
  // happen. Only once the target update actually lands do we delete the materials (idempotent) — a crash
  // between the two leaves "target upgraded, materials still present," recoverable, rather than the worse
  // "materials gone, target not upgraded" (mirrors equipment.ts reforgeEquipment's ordering).
  const targetRes = await cols.cardInstances.updateOne(
    { _id: targetId, accountId, level: curTarget.level },
    { $set: toCardDoc(updatedTarget, accountId) },
  );
  if (targetRes.matchedCount === 0) {
    await cols.cardIdem.deleteOne({ _id: idempotencyKey });
    return { error: 'target card changed concurrently, retry', code: 'REV_CONFLICT' };
  }
  // Scoped to accountId (2026-08-03 fix): ownership was validated earlier via the accountId-scoped
  // cardInstances.find above, but without this guard the delete itself would match purely on _id —
  // closing a narrow cross-account TOCTOU window (an id traded away via auction escrow + re-granted to
  // a buyer since that validation).
  await cols.cardInstances.deleteMany({ _id: { $in: ids }, accountId });

  // Saves-side: count decrement (5 material instances removed), rev-guarded.
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      await cols.cardIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    const next: SaveData = {
      ...doc.save,
      rev: doc.save.rev + 1,
      updatedAt: now(),
      cardInvCount: Math.max(0, doc.save.cardInvCount - ids.length),
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { card: updatedTarget, save: next };
  }
  await cols.cardIdem.deleteOne({ _id: idempotencyKey });
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}
