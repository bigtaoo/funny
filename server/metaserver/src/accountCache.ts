// In-process cache fronting two hot, repeatedly-queried-but-rarely-changing Mongo reads (2026-07-27 mid-term
// audit item 4/5): the per-request ban/soft-delete check (rejectIfBanned, hit on every auth + every /pve/enter
// and /pve/clear) and the publicId->accountId reverse lookup (resolveByPublicId, hit on every socialsvc
// friend/mail action that targets a player by their public id). Both are already indexed, cheap single-document
// Mongo queries — the win here is skipping the network round trip entirely on a cache hit (cross-WAN Atlas M0),
// not query-plan efficiency.
//
// Deliberately a per-instance class (constructed once per buildApp call), not a module-level singleton like
// shared/src/dailyCounter.ts's LocalBackend fallback. That singleton was safe because its keys are namespaced
// by randomly-generated accountIds; several existing tests here reuse the same literal fixture values (e.g.
// publicId '123456789') across cases with different seeded ban/profile state, so a process-wide cache would
// leak one test's cached result into the next. One AccountCache instance is threaded through both MetaService
// (public routes) and registerInternalRoutes (admin ban/unban) so an admin ban is visible to the next request
// on either path.
import type { Collections } from '@nw/shared';

interface BanStatus {
  banned: boolean;
  deletedAt: number | undefined;
  /** CONTENT_MODERATION_DESIGN.md CM6: epoch ms until which auth is rejected (temp ban); undefined/past = not currently temp-banned. */
  bannedUntil: number | undefined;
}

// Safety net only: the known mutation sites (ban/unban/deleteAccount) invalidate explicitly on write, so a
// forgotten future write site is bounded by this TTL rather than caching a stale "not banned" forever.
const BAN_STATUS_TTL_MS = 60_000;
// publicId->accountId is assigned once (ensurePublicId never reassigns an existing one) and never changes —
// long TTL here is just memory hygiene for a long-lived process, not a staleness concern.
const PUBLIC_ID_TTL_MS = 3600_000;

interface Entry<V> {
  value: V;
  expiresAt: number;
}

class TtlMap<V> {
  private store = new Map<string, Entry<V>>();
  private lastSweepAt = 0;
  constructor(private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }

  // Piggyback a full cleanup pass onto normal cache-miss traffic (at most once per ttlMs) instead of a
  // background timer — same reasoning as metaserver's SlidingRateLimiter.maybeSweep: `get()` only evicts
  // the ONE key it happens to look up, so a key that's set once and never looked up again (e.g. an
  // account that logs in once and never returns) would otherwise sit in this per-process, never-reset
  // cache for the life of the (long-running) process.
  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.ttlMs) return;
    this.lastSweepAt = now;
    for (const [k, e] of this.store) {
      if (e.expiresAt <= now) this.store.delete(k);
    }
  }

  set(key: string, value: V): void {
    const now = Date.now();
    this.maybeSweep(now);
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }
}

export class AccountCache {
  private readonly banStatus = new TtlMap<BanStatus>(BAN_STATUS_TTL_MS);
  private readonly publicIdToAccountId = new TtlMap<string>(PUBLIC_ID_TTL_MS);

  async getBanStatus(cols: Collections, accountId: string): Promise<BanStatus> {
    const cached = this.banStatus.get(accountId);
    if (cached) return cached;
    const doc = await cols.accounts.findOne({ _id: accountId }, { projection: { flags: 1, deletedAt: 1 } });
    const status: BanStatus = {
      banned: !!doc?.flags?.banned,
      deletedAt: doc?.deletedAt,
      bannedUntil: doc?.flags?.bannedUntil,
    };
    this.banStatus.set(accountId, status);
    return status;
  }

  /** Call after any write to accounts.flags.banned / .bannedUntil / accounts.deletedAt for this account (ban/unban/deleteAccount/penalty). */
  invalidateBanStatus(accountId: string): void {
    this.banStatus.delete(accountId);
  }

  async getAccountIdByPublicId(cols: Collections, publicId: string): Promise<string | null> {
    const cached = this.publicIdToAccountId.get(publicId);
    if (cached) return cached;
    const doc = await cols.accounts.findOne({ publicId }, { projection: { _id: 1 } });
    // Misses are never cached: the publicId space is large (900M) so a typo shouldn't bake in a false
    // negative indefinitely, and this keeps the cache correctly empty for an id that becomes valid later.
    if (!doc) return null;
    this.publicIdToAccountId.set(publicId, doc._id);
    return doc._id;
  }
}
