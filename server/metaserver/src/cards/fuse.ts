// cards/* split — fuseCards (see ../cards.ts for the module overview).
import {
  applyFusion,
  type Collections,
  type SaveData,
  type CardInstance,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { REV_RETRIES, idemExpireAt, toCardDoc, fromCardDoc, type CardError } from './helpers.js';
import { checkFuseShape, checkFuseRound } from './fuseRules.js';

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
  const shapeErr = checkFuseShape(targetId, materialIds);
  if (shapeErr) return shapeErr;
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };
  const ids = [...materialIds];

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
  const checked = checkFuseRound(curMap, targetId, ids);
  if ('error' in checked) return checked;
  const curTarget = checked.target;

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
  // Retries exhausted for the cardInvCount decrement, but the fusion itself (target upgrade + 5 materials
  // consumed) already committed above, unconditionally, before this loop — deleting the idem claim here
  // used to orphan that state: a client retry would re-enter this function fresh, fail to find the
  // already-deleted materials (CARD_NOT_FOUND), and report failure for a fusion that had already succeeded
  // (mirrors equipment.ts reforgeEquipment's fix). Instead, report success directly: cardInvCount is an
  // informational mirror that self-heals (see assembleCardInv), and the idem claim stays in place so a
  // retry with the same key hits the replay branch above, which already re-reads the real (fused) target
  // card state rather than trusting a cached value.
  const healedSave = await getOrCreateSave(cols, accountId, now());
  return { card: updatedTarget, save: healedSave };
}
