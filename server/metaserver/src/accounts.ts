// Account resolution (S0-4 / S0-7) + password accounts (SA-1) + OAuth (SA-2).
// Anonymous device/wx → stable accountId; password register / login / change-password; OAuth login / bind.
import { randomUUID, randomInt } from 'node:crypto';
import type { Collections, ChatRegion } from '@nw/shared';
import {
  hashPassword,
  isAnonymousAccount,
  normalizeLoginId,
  randomPlayerName,
  verifyPassword,
} from '@nw/shared';

/**
 * Best-effort: writes the lazily inferred compliance region back to the account on auth
 * (used for per-region profanity-filter word lists in private chat). Written only when region
 * is not `global` — requests with no Accept-Language signal must not downgrade an already
 * resolved real region.
 */
async function touchRegion(cols: Collections, accountId: string, region: ChatRegion): Promise<void> {
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
  await cols.accounts.updateOne(
    { deviceId },
    {
      $setOnInsert: { _id: accountId, deviceId, createdAt: now },
      ...(region !== 'global' ? { $set: { region } } : {}),
    },
    { upsert: true },
  );
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
  await cols.accounts.updateOne(
    { openid },
    {
      $setOnInsert: { _id: accountId, openid, createdAt: now },
      ...(region !== 'global' ? { $set: { region } } : {}),
    },
    { upsert: true },
  );
  const doc = await cols.accounts.findOne({ openid });
  return {
    accountId: doc ? doc._id : accountId,
    isNew: doc?._id === accountId,
    isAnonymous: doc ? isAnonymousAccount(doc) : false,
  };
}

export type RegisterResult =
  | { kind: 'ok'; account: ResolvedAccount }
  | { kind: 'taken' };

/**
 * Password registration (SA-1). Creates a **new** account (does not bind to the current anonymous
 * account — promotion/merge is done by the client after login via SaveManager.reconcile,
 * ACCOUNT_DESIGN §4.4). loginId is unique after normalization.
 */
export async function registerWithPassword(
  cols: Collections,
  loginId: string,
  password: string,
  displayName: string | undefined,
  now: number,
  region: ChatRegion = 'global',
): Promise<RegisterResult> {
  const norm = normalizeLoginId(loginId);
  const hash = await hashPassword(password);
  const accountId = randomUUID();
  // Unique index 'password.loginId' guard: if the upsert hits an existing doc, nothing is inserted → taken.
  const res = await cols.accounts.updateOne(
    { 'password.loginId': norm },
    {
      $setOnInsert: {
        _id: accountId,
        createdAt: now,
        password: { loginId: norm, hash },
        // Explicit name at registration counts as a deliberate choice → no free rename later.
        ...(displayName ? { displayName, nameChosen: true } : {}),
        ...(region !== 'global' ? { region } : {}),
      },
    },
    { upsert: true },
  );
  if (!res.upsertedId) return { kind: 'taken' };
  return { kind: 'ok', account: { accountId, isNew: true, isAnonymous: false, displayName } };
}

/** Password login (SA-1). Matches loginId after normalization + compares hashes. */
export async function loginWithPassword(
  cols: Collections,
  loginId: string,
  password: string,
  region: ChatRegion = 'global',
): Promise<ResolvedAccount | null> {
  const norm = normalizeLoginId(loginId);
  const doc = await cols.accounts.findOne({ 'password.loginId': norm });
  if (!doc?.password) return null;
  const ok = await verifyPassword(password, doc.password.hash);
  if (!ok) return null;
  await touchRegion(cols, doc._id, region);
  return { accountId: doc._id, isNew: false, isAnonymous: isAnonymousAccount(doc), displayName: doc.displayName };
}

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
 * Public profile (display name + 9-digit numeric public id). The gateway uses this to show players
 * in a room as nickname (#id) rather than accountId. publicId is lazily generated if missing.
 */
export async function getProfile(
  cols: Collections,
  accountId: string,
): Promise<{ displayName?: string; publicId: string; equippedTitle?: string; avatarId?: string }> {
  const [displayName, saveDoc, publicId] = await Promise.all([
    ensureDisplayName(cols, accountId),
    cols.saves.findOne({ _id: accountId }, { projection: { 'save.equipped': 1 } }),
    ensurePublicId(cols, accountId),
  ]);
  const equipped = saveDoc?.save.equipped as Record<string, string> | undefined;
  const equippedTitle = equipped?.['title'];
  const avatarId = equipped?.['avatar'];
  return {
    displayName,
    publicId,
    ...(equippedTitle ? { equippedTitle } : {}),
    ...(avatarId ? { avatarId } : {}),
  };
}

/**
 * Ensure the account has a 9-digit numeric public id: returns immediately if one already exists,
 * otherwise generates a globally unique one and writes it. The publicId unique index causes
 * updateOne to throw on concurrent writes or collisions → retry with a new candidate;
 * collisions are extremely rare given a space of 900 million.
 */
export async function ensurePublicId(cols: Collections, accountId: string): Promise<string> {
  const existing = await cols.accounts.findOne({ _id: accountId }, { projection: { publicId: 1 } });
  if (existing?.publicId) return existing.publicId;
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

/** Reverse-lookup accountId by 9-digit public id (admin player.lookup, OPS_DESIGN §4.1). Returns null if not found. */
export async function resolveByPublicId(
  cols: Collections,
  publicId: string,
): Promise<string | null> {
  const doc = await cols.accounts.findOne({ publicId }, { projection: { _id: 1 } });
  return doc?._id ?? null;
}

/** Escape regex metacharacters — treat ops-entered input as a literal string fed to $regex, preventing injection / ReDoS. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Hit row for admin fuzzy player search (OPS_DESIGN §4.1): summary fields only; detail is fetched separately. */
export interface AccountSearchRow {
  accountId: string;
  publicId?: string;
  displayName?: string;
  loginId?: string;
}

/**
 * Admin fuzzy player search (OPS_DESIGN §4.1): single keyword matches publicId/accountId (exact)
 * + loginId (prefix, hits unique index) + displayName (substring, case-insensitive).
 * Keywords shorter than 2 characters return empty immediately to avoid full-table scans;
 * results are capped at limit.
 */
export async function searchAccounts(
  cols: Collections,
  q: string,
  limit: number,
): Promise<AccountSearchRow[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const or: Record<string, unknown>[] = [
    { _id: term },
    { 'password.loginId': { $regex: '^' + escapeRegex(normalizeLoginId(term)) } },
    { displayName: { $regex: escapeRegex(term), $options: 'i' } },
  ];
  if (/^\d{9}$/.test(term)) or.push({ publicId: term });
  const docs = await cols.accounts
    .find(
      { $or: or },
      { projection: { _id: 1, publicId: 1, displayName: 1, 'password.loginId': 1 }, limit },
    )
    .toArray();
  return docs.map((d) => ({
    accountId: d._id,
    ...(d.publicId ? { publicId: d.publicId } : {}),
    ...(d.displayName ? { displayName: d.displayName } : {}),
    ...(d.password?.loginId ? { loginId: d.password.loginId } : {}),
  }));
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

// ── OAuth (SA-2) ────────────────────────────────────────────────────────────

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
  const doc = await cols.accounts.findOne({ 'oauth.provider': provider, 'oauth.sub': sub });
  return {
    accountId: doc ? doc._id : accountId,
    isNew: doc?._id === accountId,
    isAnonymous: false,
  };
}

export type BindResult =
  | { kind: 'ok' }
  | { kind: 'already_bound' }
  | { kind: 'login_id_taken' };

/**
 * Bind an OAuth credential to an existing account (SA-2).
 * - provider+sub not taken by another account → append to the current account's oauth[]; `isAnonymous=false`.
 * - Already taken by another account → `already_bound` (frontend should prompt the user to log in with that account instead).
 */
export async function bindOAuth(
  cols: Collections,
  accountId: string,
  provider: string,
  sub: string,
): Promise<BindResult> {
  const existing = await cols.accounts.findOne({ 'oauth.provider': provider, 'oauth.sub': sub });
  if (existing && existing._id !== accountId) return { kind: 'already_bound' };
  if (existing) return { kind: 'ok' }; // already on this account; idempotent
  await cols.accounts.updateOne(
    { _id: accountId },
    { $addToSet: { oauth: { provider, sub } } },
  );
  return { kind: 'ok' };
}

/**
 * Bind a password credential to an existing account (SA-2).
 * - loginId not yet taken → set the password field; `isAnonymous=false`.
 * - Already taken → `login_id_taken`.
 * - Account already has a password → idempotently return ok (do not overwrite; use /auth/password/change to change it).
 */
export async function bindPassword(
  cols: Collections,
  accountId: string,
  loginId: string,
  password: string,
): Promise<BindResult> {
  const norm = normalizeLoginId(loginId);
  const selfDoc = await cols.accounts.findOne({ _id: accountId });
  if (selfDoc?.password) return { kind: 'ok' }; // already has a password; idempotent
  const taken = await cols.accounts.findOne({ 'password.loginId': norm });
  if (taken && taken._id !== accountId) return { kind: 'login_id_taken' };
  const hash = await hashPassword(password);
  await cols.accounts.updateOne(
    { _id: accountId, password: { $exists: false } },
    { $set: { 'password.loginId': norm, 'password.hash': hash } },
  );
  return { kind: 'ok' };
}

export type ChangePasswordResult = 'ok' | 'no-password' | 'invalid';

/** Change password (SA-1, requires JWT). Verifies the old password then replaces the hash. */
export async function changePassword(
  cols: Collections,
  accountId: string,
  oldPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const doc = await cols.accounts.findOne({ _id: accountId });
  if (!doc?.password) return 'no-password';
  const ok = await verifyPassword(oldPassword, doc.password.hash);
  if (!ok) return 'invalid';
  const hash = await hashPassword(newPassword);
  await cols.accounts.updateOne(
    { _id: accountId },
    { $set: { 'password.hash': hash } },
  );
  return 'ok';
}

/**
 * WeChat code → openid. If NW_WX_APPID/SECRET are configured, calls the official jscode2session
 * endpoint; otherwise falls back to dev mode: uses the code directly as the openid (local
 * integration testing only).
 */
export async function exchangeWxCode(code: string): Promise<string> {
  const appid = process.env.NW_WX_APPID;
  const secret = process.env.NW_WX_SECRET;
  if (!appid || !secret) {
    return `dev-openid:${code}`;
  }
  const url =
    `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}` +
    `&secret=${secret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const body = (await resp.json()) as { openid?: string; errcode?: number; errmsg?: string };
  if (!body.openid) {
    throw new Error(`wx jscode2session failed: ${body.errcode} ${body.errmsg}`);
  }
  return body.openid;
}
