// Split from accounts.ts (2026-08-10, independent function module range 6, part 1/6).
// Identity resolution by device / WeChat openid / OAuth provider+sub — each "retrieve or create an
// account for this credential" with the same upsert-race-then-reread shape.
import { randomUUID } from 'node:crypto';
import type { Collections, ChatRegion } from '@nw/shared';
import { isAnonymousAccount } from '@nw/shared';

/**
 * Best-effort: writes the lazily inferred compliance region back to the account on auth
 * (used for per-region profanity-filter word lists in private chat). Written only when region
 * is not `global` — requests with no Accept-Language signal must not downgrade an already
 * resolved real region.
 */
export async function touchRegion(cols: Collections, accountId: string, region: ChatRegion): Promise<void> {
  if (region === 'global') return;
  await cols.accounts.updateOne({ _id: accountId }, { $set: { region } });
}

export interface ResolvedAccount {
  accountId: string;
  isNew: boolean;
  isAnonymous: boolean;
  /** Display name (set at registration); used in client profile display; defaults to undefined. */
  displayName?: string;
  /** 9-digit numeric public id (lazily generated and back-filled by {@link ensurePublicId}). */
  publicId?: string;
}

/** Retrieve or create an account by deviceId (Web / CrazyGames). Always returns the same id for the same device. */
export async function resolveByDevice(
  cols: Collections,
  deviceId: string,
  now: number,
  region: ChatRegion = 'global',
): Promise<ResolvedAccount> {
  const existing = await cols.accounts.findOne({ deviceId });
  if (existing) {
    await touchRegion(cols, existing._id, region);
    return { accountId: existing._id, isNew: false, isAnonymous: isAnonymousAccount(existing), displayName: existing.displayName };
  }

  const accountId = randomUUID();
  // deviceId unique index: on concurrent first-creation only one insert wins; the other re-reads.
  // 2026-08-03 fix: a racing upsert against a not-yet-existing unique key can throw E11000 even with
  // upsert:true (both sides see "no match" before either insert lands) — this is documented MongoDB
  // upsert-race behavior, not a bug in this query. Catch it and fall through to the re-read below,
  // same as the loser was always intended to do, instead of surfacing an unhandled 500 to a client
  // that's just retrying a dropped request.
  try {
    await cols.accounts.updateOne(
      { deviceId },
      {
        $setOnInsert: { _id: accountId, deviceId, createdAt: now },
        ...(region !== 'global' ? { $set: { region } } : {}),
      },
      { upsert: true },
    );
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  const doc = await cols.accounts.findOne({ deviceId });
  const isNew = doc?._id === accountId;
  // device-only account = anonymous; if this device already has bound credentials, use the actual value.
  return {
    accountId: doc ? doc._id : accountId,
    isNew,
    isAnonymous: doc ? isAnonymousAccount(doc) : true,
  };
}

/** Retrieve or create an account by openid (WeChat). WeChat = recoverable credential; not anonymous. */
export async function resolveByOpenid(
  cols: Collections,
  openid: string,
  now: number,
  region: ChatRegion = 'global',
): Promise<ResolvedAccount> {
  const existing = await cols.accounts.findOne({ openid });
  if (existing) {
    await touchRegion(cols, existing._id, region);
    return { accountId: existing._id, isNew: false, isAnonymous: isAnonymousAccount(existing), displayName: existing.displayName };
  }

  const accountId = randomUUID();
  // 2026-08-03 fix: see resolveByDevice's comment — a racing upsert can throw E11000 even with
  // upsert:true; catch it and fall through to the re-read below instead of an unhandled 500.
  try {
    await cols.accounts.updateOne(
      { openid },
      {
        $setOnInsert: { _id: accountId, openid, createdAt: now },
        ...(region !== 'global' ? { $set: { region } } : {}),
      },
      { upsert: true },
    );
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  const doc = await cols.accounts.findOne({ openid });
  return {
    accountId: doc ? doc._id : accountId,
    isNew: doc?._id === accountId,
    isAnonymous: doc ? isAnonymousAccount(doc) : false,
  };
}

/**
 * OAuth login (SA-2): retrieve or create an account for a verified provider + sub pair.
 * Guarded by a compound unique index on provider+sub; first login creates a new account
 * with `isAnonymous=false` (OAuth = recoverable credential).
 */
export async function resolveByOAuth(
  cols: Collections,
  provider: string,
  sub: string,
  now: number,
  region: ChatRegion = 'global',
): Promise<ResolvedAccount> {
  const existing = await cols.accounts.findOne({ 'oauth.provider': provider, 'oauth.sub': sub });
  if (existing) {
    await touchRegion(cols, existing._id, region);
    return { accountId: existing._id, isNew: false, isAnonymous: false, displayName: existing.displayName };
  }
  const accountId = randomUUID();
  // 2026-08-03 fix: see resolveByDevice's comment — a racing upsert can throw E11000 even with
  // upsert:true; catch it and fall through to the re-read below instead of an unhandled 500.
  try {
    await cols.accounts.updateOne(
      { 'oauth.provider': provider, 'oauth.sub': sub },
      {
        $setOnInsert: {
          _id: accountId,
          createdAt: now,
          oauth: [{ provider, sub }],
          ...(region !== 'global' ? { region } : {}),
        },
      },
      { upsert: true },
    );
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  const doc = await cols.accounts.findOne({ 'oauth.provider': provider, 'oauth.sub': sub });
  return {
    accountId: doc ? doc._id : accountId,
    isNew: doc?._id === accountId,
    isAnonymous: false,
  };
}
