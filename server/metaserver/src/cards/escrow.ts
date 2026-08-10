// cards/* split — escrowCard (see ../cards.ts for the module overview).
import type { Collections, SaveData, CardInstance } from '@nw/shared';
import { REV_RETRIES, idemExpireAt, fromCardDoc, type CardError } from './helpers.js';

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

  // Record ledger entry immediately — the delete above already happened unconditionally, so this claim
  // must exist BEFORE the save-count-decrement retry loop below, not only after it succeeds. Otherwise,
  // exhausting all rev-conflict retries would report REV_CONFLICT while the card is already gone with no
  // escrow record anywhere (mirrors equipment.ts's reforgeEquipment fix — see its doc comment).
  await cols.cardIdem.updateOne(
    { _id: orderId },
    { $setOnInsert: { accountId, op: 'escrow', result: card, expireAt: idemExpireAt(now()) } },
    { upsert: true },
  );

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
    if (res) return { instance: card };
  }
  // cardInvCount is an informational mirror that self-heals (see assembleCardInv) — the escrow itself
  // (delete + idem record) already committed above regardless of this decrement's outcome, so report
  // success rather than REV_CONFLICT for an operation that already happened.
  return { instance: card };
}
