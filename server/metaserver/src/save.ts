// save-service logic (S0-7). Optimistic locking via single-document atomic update (META_DESIGN.md §6.3):
// findOneAndUpdate uses {_id, rev} as a guard; among concurrent PUTs only one wins, the other gets 409.
import type { Collections, SaveData, SyncPatch } from '@nw/shared';
import { makeNewSave, createLogger } from '@nw/shared';

const log = createLogger('meta:save');

export type PutResult =
  | { kind: 'ok'; save: SaveData }
  | { kind: 'conflict'; save: SaveData };

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

/**
 * Merges only the client-sync section into the save; server-authoritative sections remain unchanged (SERVER_API.md §2.2).
 * Hard trust boundary: only the 2 whitelisted fields from the patch are read (equipped/flags); any extra fields
 * (wallet/inventory/gacha/pvp authoritative sections, and progress/materials/pveUpgrades which became
 * server-authoritative as of PVE_INTEGRITY_PLAN §8) are structurally discarded — the HTTP body is untyped,
 * so client-supplied extras are never persisted.
 * The latter three sections are written exclusively by /pve/* and ranked settlement.
 * Exported for always-run unit tests (e2e verifies only when Mongo is running; this function is pure logic and must be covered unconditionally).
 */
export function applySyncPatch(
  prev: SaveData,
  patch: SyncPatch,
  now: number,
  nextRev: number,
): SaveData {
  return {
    ...prev,
    rev: nextRev,
    updatedAt: now,
    ...(patch.equipped ? { equipped: patch.equipped } : {}),
    ...(patch.flags ? { flags: patch.flags } : {}),
  };
}

/**
 * Optimistic-lock push for the sync section. clientRev must equal the server-side rev; otherwise returns
 * conflict together with the current server-side save.
 * On success, returns the normalised save (rev+1).
 */
export async function putSave(
  cols: Collections,
  accountId: string,
  clientRev: number,
  patch: SyncPatch,
  now: number,
): Promise<PutResult> {
  const cur = await getOrCreateSave(cols, accountId, now);

  if (cur.rev !== clientRev) {
    return { kind: 'conflict', save: cur };
  }

  const next = applySyncPatch(cur, patch, now, cur.rev + 1);
  // rev guard ensures atomicity: among concurrent writes with the same rev only one matches successfully.
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId, rev: clientRev },
    { $set: { save: next, rev: next.rev } },
    { returnDocument: 'after' },
  );

  if (!res) {
    // Preempted by a concurrent write; rev has already changed → conflict; re-read the current value.
    const fresh = await getOrCreateSave(cols, accountId, now);
    return { kind: 'conflict', save: fresh };
  }
  return { kind: 'ok', save: res.save };
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
