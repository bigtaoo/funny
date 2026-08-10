// cards/* split — setCardLock (see ../cards.ts for the module overview).
import type { Collections, SaveData } from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { REV_RETRIES, type CardError } from './helpers.js';

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
