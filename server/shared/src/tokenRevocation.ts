// Token revocation list (ACCOUNT_DESIGN §C5-b "token revocation"). Player JWTs are stateless: every service
// except metaserver verifies them with the shared secret alone and never looks at the accounts database.
// That left one hole after the C5-b purge — a token of a purged account, leaked before the deletion, kept
// working on worldsvc/socialsvc/auctionsvc/gateway for up to 30 days and could re-create the very rows the
// purge had just erased (a fresh playerWorld, a friend request, an analytics user_id).
//
// Shape: metaserver owns the `tokenRevocations` collection and serves it on an internal endpoint; every
// verifying process keeps an in-memory `TokenRevocationList` that polls it (incrementally, via `since`) and
// is consulted right after the signature check. Pull instead of push because the list is tiny (one row per
// revoked account, TTL'd after the longest a token can outlive its revocation) and a poller heals itself
// after any outage — nothing to replay.
//
// Semantics: a revocation `{accountId, revokedAt}` rejects every token of that account issued at or before
// `revokedAt` (iat, second precision, rounded towards "revoked"). Tokens minted later are unaffected, so the
// same row type can serve a future "sign out everywhere" without a format change.
//
// Failure mode: fail-open until the first successful load (a process that cannot reach metaserver at boot
// keeps serving — the list only ever covered the rare leaked-token case, and a hard dependency on meta for
// every authenticated request would be worse), then keep the last known list on every later failure.
import type { InternalCaller } from './internalAuth';
import { verifyTokenPayload, type JwtConfig } from './jwt';
import { fetchInternalJson } from './internalFetch';
import type { Logger } from './logger';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a revocation row lives. A token can outlive its revocation by at most its own TTL (30d,
 * signToken's default — no env override exists) because metaserver refuses to renew a revoked token;
 * one extra day covers clock skew and the TTL monitor's own lag.
 */
export const TOKEN_REVOCATION_RETENTION_MS = 31 * DAY_MS;

/** metaserver internal route (X-Internal-Key). `?since=<epoch ms>` returns rows with revokedAt >= since. */
export const TOKEN_REVOCATIONS_PATH = '/internal/auth/token-revocations';

/** Default poll interval for every verifying process. */
export const TOKEN_REVOCATION_POLL_MS = 60 * 1000;

/**
 * Incremental polls re-read this much history before the previous `asOf`: a row's revokedAt is stamped
 * slightly before its write commits, and several metaserver processes may stamp with slightly different
 * clocks. Re-reading a few minutes of rows is free (the map dedups them).
 */
export const TOKEN_REVOCATION_POLL_OVERLAP_MS = 5 * 60 * 1000;

export interface TokenRevocationEntry {
  accountId: string;
  /** Epoch ms. Tokens with iat (s) * 1000 <= revokedAt are rejected. */
  revokedAt: number;
}

export interface TokenRevocationPage {
  /** Server clock at query time; the next poll asks for `since = asOf - overlap`. */
  asOf: number;
  revocations: TokenRevocationEntry[];
}

/** Returns null (never throws) when the source could not be read. */
export type TokenRevocationSource = (since: number) => Promise<TokenRevocationPage | null>;

export interface TokenRevocationListOpts {
  now?: () => number;
  intervalMs?: number;
  log?: Logger;
}

export class TokenRevocationList {
  private readonly revoked = new Map<string, number>();
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly log: Logger | undefined;
  private cursor: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(
    private readonly source: TokenRevocationSource,
    opts: TokenRevocationListOpts = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? TOKEN_REVOCATION_POLL_MS;
    this.log = opts.log;
  }

  /** True once one load succeeded; before that isRevoked answers false for everyone (fail-open). */
  get ready(): boolean {
    return this.cursor !== null;
  }

  get size(): number {
    return this.revoked.size;
  }

  /** `iat` in epoch seconds as carried by the JWT; a token without one is treated as issued at time 0. */
  isRevoked(accountId: string, iat: number | undefined): boolean {
    const at = this.revoked.get(accountId);
    if (at === undefined) return false;
    return (iat ?? 0) * 1000 <= at;
  }

  /** One poll; resolves false when the source failed (the previous list stays in force). */
  refresh(): Promise<boolean> {
    // Overlapping calls (the interval firing while a slow poll is still out) share one request.
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Immediate first load plus a background poll; the timer is unref'd so it never holds the process open. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async load(): Promise<boolean> {
    const since = this.cursor === null ? 0 : Math.max(0, this.cursor - TOKEN_REVOCATION_POLL_OVERLAP_MS);
    let page: TokenRevocationPage | null;
    try {
      page = await this.source(since);
    } catch (e) {
      page = null;
      this.log?.warn('token revocation poll threw', { err: (e as Error).message });
    }
    if (!page || !Array.isArray(page.revocations) || typeof page.asOf !== 'number') {
      this.log?.warn('token revocation poll failed', { ready: this.ready, size: this.revoked.size });
      return false;
    }
    for (const r of page.revocations) {
      if (typeof r?.accountId !== 'string' || typeof r.revokedAt !== 'number') continue;
      const prev = this.revoked.get(r.accountId);
      if (prev === undefined || r.revokedAt > prev) this.revoked.set(r.accountId, r.revokedAt);
    }
    // Mirror the server-side TTL so a long-lived process does not grow the map forever.
    const floor = this.now() - TOKEN_REVOCATION_RETENTION_MS;
    for (const [id, at] of this.revoked) if (at < floor) this.revoked.delete(id);
    if (this.cursor === null) this.log?.info('token revocation list loaded', { size: this.revoked.size });
    this.cursor = page.asOf;
    return true;
  }
}

/** Source that polls metaserver's internal endpoint. `metaBaseUrl` is the internal base (no trailing path). */
export function httpTokenRevocationSource(
  metaBaseUrl: string,
  opts: { caller: InternalCaller; key: string; log?: Logger; timeoutMs?: number },
): TokenRevocationSource {
  const base = metaBaseUrl.replace(/\/+$/, '');
  return async (since) => {
    const r = await fetchInternalJson<TokenRevocationPage>(`${base}${TOKEN_REVOCATIONS_PATH}?since=${since}`, {
      caller: opts.caller,
      key: opts.key,
      timeoutMs: opts.timeoutMs ?? 5000,
      label: `meta ${TOKEN_REVOCATIONS_PATH}`,
      ...(opts.log ? { log: opts.log } : {}),
    });
    return r.ok ? r.body : null;
  };
}

/**
 * A list that never revokes anything — for processes started without a metaserver URL (tests, a
 * stand-alone dev service). Callers log that the check is off; they do not have to branch on it.
 */
export function disabledTokenRevocationList(): TokenRevocationList {
  return new TokenRevocationList(async () => ({ asOf: 0, revocations: [] }));
}

/** Thrown by verifyUnrevokedToken for a valid signature on a revoked token; callers answer 410 ACCOUNT_DELETED. */
export class TokenRevokedError extends Error {
  constructor() {
    super('token revoked');
    this.name = 'TokenRevokedError';
  }
}

/**
 * verifyToken plus the revocation check — the one call every stateless service makes. Throws whatever
 * verifyToken throws for a bad token (→ 401) and TokenRevokedError for a revoked one (→ 410). A null list
 * skips the check (callers built without a metaserver URL).
 */
export function verifyUnrevokedToken(token: string, cfg: JwtConfig, list: TokenRevocationList | null | undefined): string {
  const p = verifyTokenPayload(token, cfg);
  if (list?.isRevoked(p.sub, p.iat)) throw new TokenRevokedError();
  return p.sub;
}

/**
 * Bootstrap helper for the stateless services: a started list polling `metaInternalUrl`, or null (logged
 * once as a warning) when the URL is not configured — the service then runs without the check, as before.
 */
export function startTokenRevocationList(
  metaInternalUrl: string | null | undefined,
  opts: { caller: InternalCaller; key: string; log: Logger },
): TokenRevocationList | null {
  if (!metaInternalUrl) {
    opts.log.warn('token revocation list disabled: metaserver internal URL not configured');
    return null;
  }
  const list = new TokenRevocationList(
    httpTokenRevocationSource(metaInternalUrl, { caller: opts.caller, key: opts.key, log: opts.log }),
    { log: opts.log },
  );
  list.start();
  return list;
}
