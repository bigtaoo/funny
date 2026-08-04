// DB write helper for title grants (S10, TITLE_DESIGN §2).
// The grantTitle pure function lives in @nw/shared; this module is responsible for atomically writing the computed result to MongoDB.
// Idempotent: $addToSet makes repeated calls with the same titleId safe.
import type { Collections, SaveData } from '@nw/shared';
import { grantTitle } from '@nw/shared';
import { createLogger } from '@nw/shared';

const log = createLogger('meta:titles');

/**
 * Grant a titleId to the specified player:
 *   1. Read current titles[] + equipped.title
 *   2. Compute new state using the grantTitle pure function
 *   3. Write titles with $addToSet; if the auto-equip result changed, also $set equipped.title
 *
 * Idempotent: returns early if already owned. Skipped if the player's save does not exist (lazily created on first login; grant again afterwards).
 *
 * Rev-guarded (2026-08-03 fix): this used to be a raw updateOne with no rev check, unlike every other
 * save mutation (mutateSave/mutateSaveForAudit). Title grants fire off event/achievement completion —
 * exactly when the player is likely to be concurrently mutating their own save via mutateSave — and a
 * concurrent mutateSave reading a pre-grant snapshot would commit its own rev-matched full-document
 * $set afterward, silently overwriting (dropping) the just-granted title with no error anywhere.
 */
export async function grantTitleToPlayer(
  cols: Collections,
  accountId: string,
  titleId: string,
  now: number,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      log.warn('grantTitleToPlayer: no save found, skip', { accountId, titleId });
      return;
    }

    const prevTitles: string[] = doc.save.titles ?? [];
    if (prevTitles.includes(titleId)) return; // already owned, idempotent return

    const prevEquipped: string | undefined = doc.save.equipped?.title;
    const { equippedTitle } = grantTitle(prevTitles, prevEquipped, titleId);

    const nextTitles = [...new Set([...prevTitles, titleId])];
    const next: SaveData = {
      ...doc.save,
      rev: doc.save.rev + 1,
      updatedAt: now,
      titles: nextTitles,
      // grantTitle always returns a defined equippedTitle once a title exists to grant (auto-equips
      // when nothing was previously equipped); the `?? titleId` fallback only exists to satisfy
      // Record<string, string>'s value type.
      equipped: { ...doc.save.equipped, title: equippedTitle ?? titleId },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      log.info('grantTitleToPlayer: granted', { accountId, titleId, equippedTitle });
      return;
    }
    // rev conflict (concurrent PUT /save / pve / other save write) → re-read and retry
  }
  log.warn('grantTitleToPlayer: rev conflict exhausted, title not granted', { accountId, titleId });
}
