// DB write helper for title grants (S10, TITLE_DESIGN §2).
// The grantTitle pure function lives in @nw/shared; this module is responsible for atomically writing the computed result to MongoDB.
// Idempotent: $addToSet makes repeated calls with the same titleId safe.
import type { Collections } from '@nw/shared';
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
 */
export async function grantTitleToPlayer(
  cols: Collections,
  accountId: string,
  titleId: string,
  now: number,
): Promise<void> {
  const doc = await cols.saves.findOne({ _id: accountId }, {
    projection: { 'save.titles': 1, 'save.equipped': 1 },
  });
  if (!doc) {
    log.warn('grantTitleToPlayer: no save found, skip', { accountId, titleId });
    return;
  }

  const prevTitles: string[] = (doc.save as { titles?: string[] }).titles ?? [];
  if (prevTitles.includes(titleId)) return; // already owned, idempotent return

  const prevEquipped: string | undefined = (doc.save.equipped as Record<string, string> | undefined)?.['title'];
  const { equippedTitle } = grantTitle(prevTitles, prevEquipped, titleId);

  const setFields: Record<string, unknown> = { 'save.updatedAt': now };
  if (equippedTitle !== prevEquipped) {
    setFields['save.equipped.title'] = equippedTitle;
  }

  await cols.saves.updateOne(
    { _id: accountId },
    { $addToSet: { 'save.titles': titleId } as Record<string, unknown>, $set: setFields },
  );
  log.info('grantTitleToPlayer: granted', { accountId, titleId, equippedTitle });
}
