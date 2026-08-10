// Split from accounts.ts (2026-08-10, independent function module range 6, part 4/6).
// Admin fuzzy player search (OPS_DESIGN §4.1) + the cached publicId reverse-lookup.
import type { Collections } from '@nw/shared';
import { normalizeLoginId } from '@nw/shared';
import type { AccountCache } from '../accountCache.js';

/**
 * Reverse-lookup accountId by 9-digit public id (admin player.lookup OPS_DESIGN §4.1; also the socialsvc
 * friend/mail-by-publicId path, /internal/account/by-public-id). Returns null if not found.
 * Cached (2026-07-27, accountCache.ts) — a cache hit skips the Mongo round trip entirely; the mapping is
 * assigned once and never changes, so there's no invalidation to wire up.
 */
export async function resolveByPublicId(
  cache: AccountCache,
  cols: Collections,
  publicId: string,
): Promise<string | null> {
  return cache.getAccountIdByPublicId(cols, publicId);
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
