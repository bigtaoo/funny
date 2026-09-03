// Split from accounts.ts (2026-08-10, independent function module range 6, part 3/6).
// Display name / public id / region / mute-status / rename-eligibility — the read-mostly profile
// surface consumed by GET /save, match reports, and room player lists.
import type { Collections, ChatRegion } from '@nw/shared';
import { randomInt } from 'node:crypto';
import { randomPlayerName } from '@nw/shared';

/** Read the account's compliance region (used for private-chat profanity-filter word list selection). Missing field on old accounts defaults to `'global'`. */
export async function getRegion(cols: Collections, accountId: string): Promise<ChatRegion> {
  const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { region: 1 } });
  return doc?.region ?? 'global';
}

/** Read the account's display name (returned alongside GET /save; restores profile on token re-login). Lazily backfills a default if unset (see {@link ensureDisplayName}). */
export async function getDisplayName(
  cols: Collections,
  accountId: string,
): Promise<string | undefined> {
  return ensureDisplayName(cols, accountId);
}

/**
 * Ensure the account has a display name: returns the existing one immediately, otherwise lazily
 * assigns and persists a random default. Mirrors {@link ensurePublicId}'s lazy-backfill pattern —
 * displayName is optional at registration/device-login, so without this, guest accounts (the
 * majority) would never have a nickname to show in match history, room player lists, etc.,
 * and those surfaces would permanently fall back to a raw id.
 */
export async function ensureDisplayName(cols: Collections, accountId: string): Promise<string> {
  const existing = await cols.accounts.findOne({ _id: accountId }, { projection: { displayName: 1 } });
  if (existing?.displayName) return existing.displayName;
  const candidate = randomPlayerName();
  const res = await cols.accounts.updateOne(
    { _id: accountId, displayName: { $exists: false } },
    { $set: { displayName: candidate } },
  );
  if (res.modifiedCount === 1) return candidate;
  const now = await cols.accounts.findOne({ _id: accountId }, { projection: { displayName: 1 } });
  return now?.displayName ?? candidate;
}

/**
 * CONTENT_MODERATION_DESIGN.md CM7.1: mute status, piggybacked on the profile fetch worldsvc's
 * sendMessage() already makes on every post — no extra cross-service round trip for the mute check.
 * A dedicated async function (not an inline `cols.accounts.findOne(...)` expression in a Promise.all
 * array) so a missing/misconfigured `cols.accounts` in a caller's test double rejects like the other
 * Promise.all members instead of throwing synchronously while the array literal is still being built
 * (which would happen before Promise.all ever runs, orphaning the other members' promises).
 */
async function getMutedUntil(cols: Collections, accountId: string): Promise<number | undefined> {
  const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { 'flags.mutedUntil': 1 } });
  return doc?.flags?.mutedUntil;
}

/**
 * Public profile (display name + 9-digit numeric public id). The gateway uses this to show players
 * in a room as nickname (#id) rather than accountId. publicId is lazily generated if missing.
 */
export async function getProfile(
  cols: Collections,
  accountId: string,
): Promise<{ displayName?: string; publicId: string; equippedTitle?: string; avatarId?: string; equippedSkins?: string[]; mutedUntil?: number }> {
  const [displayName, saveDoc, publicId, mutedUntil] = await Promise.all([
    ensureDisplayName(cols, accountId),
    cols.saves.findOne({ _id: accountId }, { projection: { 'save.equipped': 1 } }),
    ensurePublicId(cols, accountId),
    getMutedUntil(cols, accountId),
  ]);
  const equipped = saveDoc?.save.equipped as Record<string, string> | undefined;
  const equippedTitle = equipped?.['title'];
  const avatarId = equipped?.['avatar'];
  // Character skin slots are keyed 'skin:<unitType>' (client/src/game/meta/skinDefs.ts
  // skinEquipKey/allEquippedSkins) — one slot per character, unlike title/avatar's single slot.
  const equippedSkins = equipped
    ? Object.entries(equipped).filter(([k]) => k.startsWith('skin:')).map(([, v]) => v)
    : undefined;
  return {
    displayName,
    publicId,
    ...(equippedTitle ? { equippedTitle } : {}),
    ...(avatarId ? { avatarId } : {}),
    ...(equippedSkins && equippedSkins.length ? { equippedSkins } : {}),
    ...(mutedUntil ? { mutedUntil } : {}),
  };
}

/**
 * Thrown when the accounts row for an authenticated request no longer exists — a hard-deleted account
 * whose JWT has not expired yet. Callers on the player-facing surface translate this into 410
 * ACCOUNT_DELETED, the same status {@link MetaCore.rejectIfBanned} answers for a *soft*-deleted account,
 * so the client's "your account is gone" handling fires for both instead of only one.
 */
export class AccountGoneError extends Error {
  constructor(readonly accountId: string) {
    super(`account ${accountId} no longer exists`);
    this.name = 'AccountGoneError';
  }
}

/**
 * Ensure the account has a 9-digit numeric public id: returns immediately if one already exists,
 * otherwise generates a globally unique one and writes it. The publicId unique index causes
 * updateOne to throw on concurrent writes or collisions → retry with a new candidate;
 * collisions are extremely rare given a space of 900 million.
 *
 * Throws {@link AccountGoneError} when the accounts row itself is missing (2026-09-03 fix): the guarded
 * `{_id, publicId:{$exists:false}}` update below can never match a document that does not exist and the
 * re-read can never find one either, so all 8 attempts used to burn out into a generic
 * "failed to allocate publicId after retries" — surfacing a hard-deleted account holding a still-valid
 * JWT as a 500 instead of a 410.
 */
export async function ensurePublicId(cols: Collections, accountId: string): Promise<string> {
  const existing = await cols.accounts.findOne({ _id: accountId }, { projection: { publicId: 1 } });
  if (existing?.publicId) return existing.publicId;
  if (!existing) throw new AccountGoneError(accountId);
  for (let attempt = 0; attempt < 8; attempt++) {
    // 100000000–999999999: exactly 9 digits, first digit non-zero.
    const candidate = String(randomInt(100_000_000, 1_000_000_000));
    try {
      // Write only if this account does not yet have a publicId; the unique index prevents collisions across accounts.
      const res = await cols.accounts.updateOne(
        { _id: accountId, publicId: { $exists: false } },
        { $set: { publicId: candidate } },
      );
      if (res.modifiedCount === 1) return candidate;
      // Nothing modified: a concurrent write may have already set it → re-read to get the actual value.
      const now = await cols.accounts.findOne({ _id: accountId }, { projection: { publicId: 1 } });
      if (now?.publicId) return now.publicId;
    } catch {
      // Unique index collision (candidate already taken by another account) → retry with a new candidate.
    }
  }
  throw new Error('failed to allocate publicId after retries');
}

/**
 * Update the display name (rename feature; called after coins have already been deducted, or for the
 * one-time free rename). Always marks the name as deliberately chosen, so any subsequent rename is paid.
 */
export async function setDisplayName(
  cols: Collections,
  accountId: string,
  displayName: string,
): Promise<void> {
  await cols.accounts.updateOne({ _id: accountId }, { $set: { displayName, nameChosen: true } });
}

/**
 * Whether the account still has its free rename available: true when the player has never deliberately
 * chosen a display name (current name is a system-assigned default, or none yet). Drives both the free
 * rename in profileRename and the `freeRename` hint returned with GET /save.
 */
export async function hasFreeRename(cols: Collections, accountId: string): Promise<boolean> {
  const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { nameChosen: 1 } });
  return !doc?.nameChosen;
}
