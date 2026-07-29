// save-service logic (S0-7). Optimistic locking via single-document atomic update (META_DESIGN.md §6.3):
// findOneAndUpdate uses {_id, rev} as a guard — mutateSave (service/base.ts) is the sole writer now
// that PUT /save (the old generic client-sync endpoint) has been removed; every mutation goes through
// a dedicated, per-field validated endpoint (see DECISIONS.md "equipped/flags server-authoritative").
import type { Collections, SaveData } from '@nw/shared';
import { makeNewSave, createLogger } from '@nw/shared';

const log = createLogger('meta:save');

/** Fetch the save; if it does not exist, create a fresh one and persist it. */
export async function getOrCreateSave(
  cols: Collections,
  accountId: string,
  now: number,
): Promise<SaveData> {
  const doc = await cols.saves.findOne({ _id: accountId });
  if (doc) return doc.save;

  const save = makeNewSave(accountId, now);
  // upsert prevents a first-create race under concurrency: if already present, the existing document is returned.
  await cols.saves.updateOne(
    { _id: accountId },
    { $setOnInsert: { _id: accountId, save, rev: save.rev } },
    { upsert: true },
  );
  const fresh = await cols.saves.findOne({ _id: accountId });
  return fresh ? fresh.save : save;
}

/** Preset avatar slot ids (avatar.ts AVATAR_DEFS, indices 0-7) — always unlocked, no ownership check.
 *  Single source of truth for isAvatarOwned below, used by service/liveops.ts's equipAvatar. */
export const PRESET_AVATAR_IDS = new Set(['0', '1', '2', '3', '4', '5', '6', '7']);

/**
 * Whether `avatarId` (composite "<category>:<key>", or a bare preset digit for backward compat) is
 * unlocked for this account. Every category except preset requires the key to appear in the
 * account's lifetime-owned records (titles[] / everOwned.* / inventory.skins) — obtained once,
 * unlocked forever, even if the item has since been salvaged/consumed/sold.
 */
export function isAvatarOwned(save: SaveData, avatarId: string): boolean {
  if (PRESET_AVATAR_IDS.has(avatarId)) return true;
  const sep = avatarId.indexOf(':');
  const category = sep < 0 ? avatarId : avatarId.slice(0, sep);
  const key = sep < 0 ? '' : avatarId.slice(sep + 1);
  switch (category) {
    case 'preset': return true;
    case 'title': return (save.titles ?? []).includes(key);
    case 'hero': return (save.everOwned?.hero ?? []).includes(key);
    case 'equip': return (save.everOwned?.equipment ?? []).includes(key);
    case 'material': return (save.everOwned?.material ?? []).includes(key);
    case 'skin': return (save.inventory?.skins ?? []).includes(key) || (save.everOwned?.skin ?? []).includes(key);
    default: return false;
  }
}

/** Whether `skinId` is unlocked for equipping (current inventory or the lifetime-owned ledger). */
export function isSkinOwned(save: SaveData, skinId: string): boolean {
  return (save.inventory?.skins ?? []).includes(skinId) || (save.everOwned?.skin ?? []).includes(skinId);
}

/**
 * Atomically writes the migrated save (including rev+1) to the database, retrying up to 3 times.
 * Used in the "read save → migrateIfStale yields new save → write back" flow.
 * On concurrent conflict, re-reads the current save, migrates it again, and retries
 * (idempotent: re-entering migration does not double-settle or double-reset anything).
 * Returns the save that was ultimately persisted.
 */
export async function writeMigratedSave(
  cols: Collections,
  migratedSave: SaveData,
  now: number,
  migrate: (save: SaveData) => Promise<{ migrated: boolean; save: SaveData }>,
): Promise<SaveData> {
  let save = migratedSave;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next: SaveData = { ...save, rev: save.rev + 1, updatedAt: now };
    const res = await cols.saves.findOneAndUpdate(
      { _id: save.accountId, rev: save.rev },
      { $set: { save: next, rev: next.rev } },
      { returnDocument: 'after' },
    );
    if (res) return res.save;
    // Concurrent conflict: re-read + migrate again, then retry
    const cur = await cols.saves.findOne({ _id: save.accountId });
    if (!cur) return save;
    const r = await migrate(cur.save);
    if (!r.migrated) return cur.save; // already migrated by a concurrent writer
    save = r.save;
    log.info('writeMigratedSave: retrying after conflict', { accountId: save.accountId, attempt });
  }
  return save;
}
