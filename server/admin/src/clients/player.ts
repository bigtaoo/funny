import { internalHeaders } from '@nw/shared';
import { log } from './shared';

// ── Player lookup (meta, player.lookup) ────────────────────
export interface PlayerProfile {
  publicId: string;
  accountId?: string;
  displayName?: string;
  rank?: string;
  elo?: number;
  wins?: number;
  losses?: number;
  banned?: boolean;
}

/** Fuzzy search hit row (= meta AccountSearchRow, shown in OPS list views). */
export interface PlayerSummary {
  accountId: string;
  publicId?: string;
  displayName?: string;
  loginId?: string;
}

export type ResetPasswordResult = { ok: true } | { ok: false; error: string };

export interface PlayerClient {
  readonly available: boolean;
  /** Look up a player profile by 9-digit public id; returns null if not found. */
  lookupByPublicId(publicId: string): Promise<PlayerProfile | null>;
  /** Look up a player profile by accountId; returns null if not found. */
  lookupByAccountId(accountId: string): Promise<PlayerProfile | null>;
  /** Fuzzy search (display name / login id / public id / accountId); returns a list of matching summaries. */
  search(q: string, limit: number): Promise<PlayerSummary[]>;
  /** Admin-initiated password reset (player.password_reset); fails if the account has no password credential. */
  resetPassword(accountId: string, password: string): Promise<ResetPasswordResult>;
}

export class HttpPlayerClient implements PlayerClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async lookupByPublicId(publicId: string): Promise<PlayerProfile | null> {
    return this.lookup(`publicId=${encodeURIComponent(publicId)}`);
  }

  async lookupByAccountId(accountId: string): Promise<PlayerProfile | null> {
    return this.lookup(`accountId=${encodeURIComponent(accountId)}`);
  }

  private async lookup(qs: string): Promise<PlayerProfile | null> {
    if (!this.metaBaseUrl) return null;
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/player?${qs}`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        log.warn('player lookup non-2xx', { status: res.status });
        return null;
      }
      return (await res.json()) as PlayerProfile;
    } catch (e) {
      log.warn('player lookup failed', { err: (e as Error).message });
      return null;
    }
  }

  async search(q: string, limit: number): Promise<PlayerSummary[]> {
    if (!this.metaBaseUrl) return [];
    try {
      const res = await fetch(
        `${this.metaBaseUrl}/internal/players/search?q=${encodeURIComponent(q)}&limit=${limit}`,
        { headers: internalHeaders('admin', this.internalKey) },
      );
      if (!res.ok) {
        log.warn('player search non-2xx', { status: res.status });
        return [];
      }
      return ((await res.json()) as { players: PlayerSummary[] }).players;
    } catch (e) {
      log.warn('player search failed', { err: (e as Error).message });
      return [];
    }
  }

  async resetPassword(accountId: string, password: string): Promise<ResetPasswordResult> {
    if (!this.metaBaseUrl) return { ok: false, error: 'player backend unavailable' };
    try {
      const res = await fetch(
        `${this.metaBaseUrl}/internal/accounts/${encodeURIComponent(accountId)}/reset-password`,
        {
          method: 'POST',
          headers: { ...internalHeaders('admin', this.internalKey), 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        },
      );
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? `http ${res.status}` };
    } catch (e) {
      log.warn('reset player password failed', { err: (e as Error).message });
      return { ok: false, error: 'request failed' };
    }
  }
}
